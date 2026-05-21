import fs from "node:fs/promises";
import net, { type Socket } from "node:net";
import { createHash } from "node:crypto";

import { ensureDaemonDir, daemonLogPath, daemonSocketPath, serverLogPath } from "./daemon-paths";
import { readJsonLines, requestJsonLine, writeJsonLine } from "./daemon-io";
import {
  DAEMON_PROTOCOL_VERSION,
  type ClientMessage,
  type DaemonMessage,
  type DaemonStatus,
  type McpNotification,
} from "./daemon-protocol";
import { connectMcpClient, listAllMcpTools, type McpConnection } from "./mcp-client";
import { createNotificationBuffer, type NotificationBuffer } from "./notifications";
import type { McpTool, ServerConfig } from "./types";
import { MCPX_VERSION } from "./version";

const CHILD_IDLE_TTL_MS = 15 * 60 * 1000;
const DAEMON_IDLE_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 1000;
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const EVICT_DEADLINE_MS = 5_000;

type ConnectedSession = McpConnection;

type ManagedSession = {
  serverKey: string;
  labels: Set<string>;
  server: ServerConfig;
  headers?: Record<string, string> | undefined;
  connection?: ConnectedSession;
  connecting?: Promise<ConnectedSession>;
  queue: Promise<unknown>;
  activeCalls: number;
  queuedCalls: number;
  lastUsedAt: number;
  evictCount: number;
  lastSessionId?: string | undefined;
  currentBuffer?: NotificationBuffer | undefined;
  pendingToolsChanged: boolean;
};

type DaemonCallResult = {
  result: unknown;
  notifications: ReturnType<NotificationBuffer["flush"]>;
  toolsChanged: boolean;
};

const sessions = new Map<string, ManagedSession>();
let stopping = false;
let lastDaemonActivity = Date.now();

export async function runDaemonServer(): Promise<void> {
  await ensureDaemonDir();
  const socketPath = daemonSocketPath();
  if (await isLiveSocket(socketPath)) return;
  await fs.rm(socketPath, { force: true }).catch(() => {});

  const server = net.createServer(handleConnection);
  try {
    await listen(server, socketPath);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "EADDRINUSE" &&
      (await isLiveSocket(socketPath))
    ) {
      return;
    }
    throw error;
  }
  await logDaemon(`mcpxd started pid=${process.pid}`);

  const cleanupTimer = setInterval(() => {
    void cleanupIdleSessions(server);
  }, CLEANUP_INTERVAL_MS);

  await new Promise<void>((resolve) => {
    server.on("close", resolve);
  });
  clearInterval(cleanupTimer);
}

function handleConnection(socket: Socket): void {
  readJsonLines(
    socket,
    (message) => {
      void handleMessage(socket, message);
    },
    (error) => {
      writeJsonLine(socket, errorResponse("invalid-json", error.message));
    },
  );
}

async function handleMessage(socket: Socket, message: unknown): Promise<void> {
  lastDaemonActivity = Date.now();
  if (!isClientMessage(message)) {
    writeJsonLine(socket, errorResponse("invalid-message", "Invalid mcpxd message."));
    return;
  }

  try {
    if (message.op === "hello" && message.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
      writeJsonLine(
        socket,
        errorResponse(
          "protocol-mismatch",
          `Unsupported mcpxd protocol ${message.protocolVersion}; expected ${DAEMON_PROTOCOL_VERSION}.`,
        ),
      );
      return;
    }
    if (stopping && message.op !== "hello" && message.op !== "stop") {
      writeJsonLine(socket, errorResponse("daemon-stopping", "mcpxd is stopping."));
      return;
    }

    switch (message.op) {
      case "hello":
        writeJsonLine(socket, {
          ok: true,
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          result: {
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            version: MCPX_VERSION,
          },
        } satisfies DaemonMessage);
        return;
      case "listTools":
        writeJsonLine(socket, okResponse(await listTools(message)));
        return;
      case "call":
        writeJsonLine(socket, callResponse(await callTool(message)));
        return;
      case "status":
        writeJsonLine(socket, okResponse(status()));
        return;
      case "evictSession":
        writeJsonLine(socket, okResponse(await evictSession(message)));
        return;
      case "stop":
        writeJsonLine(socket, okResponse({ stopping: true }));
        await stopDaemon();
        return;
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    writeJsonLine(socket, errorResponse("operation-failed", messageText));
  }
}

async function listTools(message: Extract<ClientMessage, { op: "listTools" }>): Promise<McpTool[]> {
  return enqueue(
    message.serverKey,
    message.serverName,
    message.server,
    message.headers,
    async (session) => listAllMcpTools((await ensureConnected(session)).client),
  );
}

async function callTool(
  message: Extract<ClientMessage, { op: "call" }>,
): Promise<DaemonCallResult> {
  return enqueue(
    message.serverKey,
    message.serverName,
    message.server,
    message.headers,
    async (session) => {
      const buffer = createNotificationBuffer();
      session.currentBuffer = message.notificationMode === "discard" ? undefined : buffer;
      try {
        const result = await callToolWithRetainedSessionFallback(session, message, buffer);
        const notifications = buffer.flush();
        const toolsChanged = buffer.toolsChanged() || session.pendingToolsChanged;
        session.pendingToolsChanged = false;
        return { result, notifications, toolsChanged };
      } catch (error) {
        if (session.server.transport === "http" && isUnauthorizedError(error)) {
          session.lastSessionId = session.connection?.sessionId() ?? session.lastSessionId;
          await closeSession(session);
          session.evictCount += 1;
        }
        throw error;
      } finally {
        delete session.currentBuffer;
      }
    },
  );
}

async function callToolWithRetainedSessionFallback(
  session: ManagedSession,
  message: Extract<ClientMessage, { op: "call" }>,
  buffer: NotificationBuffer,
): Promise<unknown> {
  try {
    return await callToolOnConnectedSession(session, message, buffer);
  } catch (error) {
    if (
      session.server.transport === "http" &&
      session.lastSessionId &&
      isRetainedSessionRejected(error)
    ) {
      await closeSession(session);
      delete session.lastSessionId;
      return callToolOnConnectedSession(session, message, buffer);
    }
    throw error;
  }
}

async function callToolOnConnectedSession(
  session: ManagedSession,
  message: Extract<ClientMessage, { op: "call" }>,
  buffer: NotificationBuffer,
): Promise<unknown> {
  const connection = await ensureConnected(session);
  return connection.client.callTool(
    {
      name: message.toolName,
      arguments: message.input,
    },
    undefined,
    {
      onprogress: (progress) => {
        buffer.add({
          method: "notifications/progress",
          params: { progressToken: message.callId, ...progress },
        });
      },
    },
  );
}

async function enqueue<T>(
  serverKey: string,
  serverName: string,
  serverConfig: ServerConfig,
  headers: Record<string, string> | undefined,
  run: (session: ManagedSession) => Promise<T>,
): Promise<T> {
  const session = getSession(serverKey, serverName, serverConfig, headers);
  if (headers) {
    session.headers = headers;
    session.connection?.updateHeaders(headers);
  }
  session.queuedCalls += 1;

  const task = session.queue.then(async () => {
    session.queuedCalls -= 1;
    session.activeCalls += 1;
    try {
      return await run(session);
    } finally {
      session.activeCalls -= 1;
      session.lastUsedAt = Date.now();
      lastDaemonActivity = Date.now();
    }
  });

  session.queue = task.catch(() => {});
  return task;
}

function getSession(
  serverKey: string,
  serverName: string,
  serverConfig: ServerConfig,
  headers: Record<string, string> | undefined,
): ManagedSession {
  const existing = sessions.get(serverKey);
  if (existing) {
    existing.labels.add(serverName);
    existing.server = serverConfig;
    if (headers) existing.headers = headers;
    return existing;
  }

  const session: ManagedSession = {
    serverKey,
    labels: new Set([serverName]),
    server: serverConfig,
    headers,
    queue: Promise.resolve(),
    activeCalls: 0,
    queuedCalls: 0,
    lastUsedAt: Date.now(),
    evictCount: 0,
    pendingToolsChanged: false,
  };
  sessions.set(serverKey, session);
  return session;
}

async function ensureConnected(session: ManagedSession): Promise<ConnectedSession> {
  if (session.connection) return session.connection;
  if (!session.connecting) {
    session.connecting = connectMcpClient(session.server, {
      headers: session.headers,
      sessionId: session.lastSessionId,
      onNotification: (notification) => {
        recordNotification(session, notification);
      },
    })
      .catch(async (error) => {
        if (session.lastSessionId && isRetainedSessionRejected(error)) {
          delete session.lastSessionId;
          return connectMcpClient(session.server, {
            headers: session.headers,
            onNotification: (notification) => {
              recordNotification(session, notification);
            },
          });
        }
        throw error;
      })
      .then((connection) => {
        session.connection = connection;
        attachStderrLog(session, connection);
        void logDaemon(`started server=${session.serverKey} pid=${connection.pid() ?? "unknown"}`);
        return connection;
      })
      .finally(() => {
        delete session.connecting;
      });
  }
  return session.connecting;
}

async function evictSession(
  message: Extract<ClientMessage, { op: "evictSession" }>,
): Promise<Record<string, unknown>> {
  const session = sessions.get(message.serverKey);
  if (!session) return { evicted: false };
  if (session.server.transport === "stdio") return { evicted: false, reason: "stdio" };

  const evictTask = session.queue.then(async () => {
    // Real HTTP servers can bind session ids to the old bearer token.
    await closeSession(session, { retainHttpSessionId: message.reason !== "auth-refreshed" });
    if (message.reason === "auth-refreshed") delete session.lastSessionId;
    session.evictCount += 1;
    return { evicted: true };
  });
  session.queue = evictTask.catch(() => {});

  const timeout = new Promise<{ evicted: false; timedOut: true }>((resolve) => {
    setTimeout(() => resolve({ evicted: false, timedOut: true }), EVICT_DEADLINE_MS).unref();
  });
  return Promise.race([evictTask, timeout]);
}

function recordNotification(
  session: ManagedSession,
  notification: { method: string; params?: unknown },
): void {
  const normalized = normalizeNotification(notification);
  if (session.currentBuffer) {
    session.currentBuffer.add(normalized);
    return;
  }
  if (normalized.method === "notifications/tools/list_changed") {
    session.pendingToolsChanged = true;
  }
}

function normalizeNotification(notification: {
  method: string;
  params?: unknown;
}): McpNotification {
  const normalized: McpNotification = { method: notification.method };
  if ("params" in notification) normalized.params = notification.params;
  return normalized;
}

function attachStderrLog(session: ManagedSession, connection: ConnectedSession): void {
  const stderr = connection.stderr;
  if (!stderr) return;

  stderr.on("data", (chunk) => {
    void appendLog(serverLogPath(session.serverKey), chunk.toString());
  });
}

async function cleanupIdleSessions(server: net.Server): Promise<void> {
  if (stopping) return;

  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.activeCalls > 0 || session.queuedCalls > 0) continue;
    if (now - session.lastUsedAt < CHILD_IDLE_TTL_MS) continue;
    await closeSession(session);
    sessions.delete(session.serverKey);
  }

  if (sessions.size === 0 && now - lastDaemonActivity >= DAEMON_IDLE_TTL_MS) {
    await logDaemon("mcpxd idle timeout reached");
    server.close();
  }
}

async function stopDaemon(): Promise<void> {
  stopping = true;
  await Promise.all([...sessions.values()].map((session) => session.queue.catch(() => {})));
  await Promise.all([...sessions.values()].map((session) => closeSession(session)));
  sessions.clear();
  await fs.rm(daemonSocketPath(), { force: true }).catch(() => {});
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 10).unref();
}

async function closeSession(
  session: ManagedSession,
  options: { retainHttpSessionId?: boolean } = {},
): Promise<void> {
  const retainHttpSessionId = options.retainHttpSessionId ?? true;
  if (session.server.transport === "http" && retainHttpSessionId) {
    session.lastSessionId = session.connection?.sessionId() ?? session.lastSessionId;
  }
  await session.connection?.close().catch(() => {});
  delete session.connection;
  delete session.connecting;
  await logDaemon(`stopped server=${session.serverKey}`);
}

function status(): DaemonStatus {
  const now = Date.now();
  return {
    pid: process.pid,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    version: MCPX_VERSION,
    activeServers: sessions.size,
    servers: [...sessions.values()].map((session) => {
      const item: DaemonStatus["servers"][number] = {
        serverKey: session.serverKey,
        transport: session.server.transport ?? "http",
        labels: [...session.labels].sort(),
        activeCalls: session.activeCalls,
        queuedCalls: session.queuedCalls,
        idleMs: now - session.lastUsedAt,
        evictCount: session.evictCount,
        hasRetainedSessionId: session.lastSessionId !== undefined,
      };
      if (session.server.transport === "stdio") {
        item.pid = session.connection?.pid() ?? null;
      } else {
        item.url = redactedUrl(session.server.url);
      }
      if (session.lastSessionId) item.sessionIdHash = shortHash(session.lastSessionId);
      return item;
    }),
  };
}

function okResponse(result: unknown): DaemonMessage {
  return { ok: true, result };
}

function callResponse(result: DaemonCallResult): DaemonMessage {
  const response: DaemonMessage = { ok: true, result: result.result };
  if (result.notifications.length > 0) response.notifications = result.notifications;
  if (result.toolsChanged) response.toolsChanged = true;
  return response;
}

function errorResponse(code: string, message: string): DaemonMessage {
  return { ok: false, error: { code, message } };
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      fs.chmod(socketPath, 0o600).then(resolve, reject);
    });
  });
}

async function logDaemon(message: string): Promise<void> {
  await appendLog(daemonLogPath(), `${new Date().toISOString()} ${message}\n`);
}

async function appendLog(filePath: string, text: string): Promise<void> {
  await rotateLogIfNeeded(filePath, Buffer.byteLength(text)).catch(() => {});
  await fs.appendFile(filePath, text, "utf8").catch(() => {});
}

async function rotateLogIfNeeded(filePath: string, incomingBytes: number): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat || stat.size + incomingBytes <= LOG_MAX_BYTES) return;

  await fs.rm(`${filePath}.2`, { force: true }).catch(() => {});
  await fs.rename(`${filePath}.1`, `${filePath}.2`).catch(() => {});
  await fs.rename(filePath, `${filePath}.1`).catch(() => {});
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== "object") return false;
  const op = (value as { op?: unknown }).op;
  return (
    op === "hello" ||
    op === "listTools" ||
    op === "call" ||
    op === "status" ||
    op === "stop" ||
    op === "evictSession"
  );
}

function redactedUrl(value: string): string {
  const url = new URL(value);
  return `${url.host}${url.pathname}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isRetainedSessionRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    message.includes("404") ||
    normalized.includes("bad session") ||
    // PostHog returns this when a retained session id outlives its access token.
    normalized.includes("invalid api key") ||
    normalized.includes("invalid_api_key")
  );
}

function isUnauthorizedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("401") || message.toLowerCase().includes("unauthorized");
}

async function isLiveSocket(socketPath: string): Promise<boolean> {
  const socket = await connectSocket(socketPath).catch(() => undefined);
  if (!socket) return false;
  try {
    const parsed = (await requestJsonLine(socket, {
      op: "hello",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      clientVersion: MCPX_VERSION,
    } satisfies ClientMessage)) as DaemonMessage;
    return parsed.ok === true && parsed.protocolVersion === DAEMON_PROTOCOL_VERSION;
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}

async function connectSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
