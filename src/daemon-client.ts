import net from "node:net";

import { ensureDaemonDir, daemonSocketPath } from "./daemon-paths";
import { requestJsonLine } from "./daemon-io";
import { daemonOutputEnvelope } from "./daemon-result";
import {
  DAEMON_PROTOCOL_VERSION,
  buildServerKey,
  helloMessage,
  type ClientMessage,
  type DaemonMessage,
  type DaemonStatus,
} from "./daemon-protocol";
import { resolveHeadersWithState } from "./headers";
import type { McpTool, ServerConfig } from "./types";

const START_TIMEOUT_MS = 3_000;
const CONNECT_RETRY_MS = 50;

export async function listToolsViaDaemon(
  server: ServerConfig,
  serverName: string,
): Promise<McpTool[]> {
  const context = await daemonRequestContext(server);
  if (context.authRefreshed) {
    await evictDaemonSession(
      context.serverKey,
      "auth-refreshed",
      process.argv[1] ?? import.meta.path,
    );
  }
  const message: ClientMessage = {
    op: "listTools",
    callId: crypto.randomUUID(),
    serverName,
    serverKey: context.serverKey,
    server,
  };
  if (context.headers) message.headers = context.headers;
  const result = await requestDaemon(message, process.argv[1] ?? import.meta.path);
  return result as McpTool[];
}

export async function callToolViaDaemon(
  server: ServerConfig,
  serverName: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const context = await daemonRequestContext(server);
  if (context.authRefreshed) {
    await evictDaemonSession(
      context.serverKey,
      "auth-refreshed",
      process.argv[1] ?? import.meta.path,
    );
  }
  const message: ClientMessage = {
    op: "call",
    callId: crypto.randomUUID(),
    serverName,
    serverKey: context.serverKey,
    server,
    toolName,
    input,
  };
  if (context.headers) message.headers = context.headers;
  const response = await requestDaemonMessage(message, process.argv[1] ?? import.meta.path);
  if (response.ok && (response.notifications?.length || response.toolsChanged)) {
    return daemonOutputEnvelope({
      result: response.result,
      notifications: response.notifications ?? [],
      toolsChanged: response.toolsChanged === true,
    });
  }
  return response.ok ? response.result : undefined;
}

export async function daemonStatus(mainPath: string): Promise<DaemonStatus> {
  return requestDaemon({ op: "status" }, mainPath, { start: false }) as Promise<DaemonStatus>;
}

export async function stopDaemon(mainPath: string): Promise<unknown> {
  return requestDaemon({ op: "stop" }, mainPath, { start: false });
}

async function evictDaemonSession(
  serverKey: string,
  reason: "auth-refreshed" | "unauthorized" | "manual",
  mainPath: string,
): Promise<void> {
  await requestDaemon({ op: "evictSession", serverKey, reason }, mainPath);
}

async function daemonRequestContext(server: ServerConfig): Promise<{
  serverKey: string;
  headers?: Record<string, string>;
  authRefreshed: boolean;
}> {
  const serverKey = buildServerKey(server);
  if (server.transport === "stdio") return { serverKey, authRefreshed: false };
  const resolved = await resolveHeadersWithState(server);
  return { serverKey, headers: resolved.headers, authRefreshed: resolved.authRefreshed };
}

async function requestDaemon(
  message: ClientMessage,
  mainPath: string,
  options: { start?: boolean } = {},
): Promise<unknown> {
  const response = await requestDaemonMessage(message, mainPath, options);
  if (response.ok) return response.result ?? response;
  throw new Error(response.error.message);
}

async function requestDaemonMessage(
  message: ClientMessage,
  mainPath: string,
  options: { start?: boolean } = {},
): Promise<DaemonMessage> {
  const start = options.start ?? true;
  if (start) await ensureDaemon(mainPath);
  return withDaemonConnection(async (socket) => {
    await sendAndExpectOk(socket, helloMessage());
    return sendAndExpectDaemonMessage(socket, message);
  });
}

async function ensureDaemon(mainPath: string): Promise<void> {
  const state = await probeDaemon();
  if (state === "compatible") return;
  if (state === "incompatible") {
    try {
      await stopIncompatibleDaemon();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to stop incompatible mcpxd: ${message}`);
    }
  }

  await ensureDaemonDir();
  Bun.spawn([process.execPath, mainPath, "@daemon", "server"], {
    env: {
      ...process.env,
      MCPX_DAEMON_SERVER: "1",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await canHandshake()) return;
    await sleep(CONNECT_RETRY_MS);
  }
  throw new Error("mcpxd did not start before the startup timeout.");
}

async function canHandshake(): Promise<boolean> {
  return (await probeDaemon()) === "compatible";
}

async function probeDaemon(): Promise<"compatible" | "incompatible" | "missing"> {
  try {
    const result = await withDaemonConnection((socket) => sendAndExpectOk(socket, helloMessage()));
    const version =
      typeof result === "object" && result !== null && "protocolVersion" in result
        ? result.protocolVersion
        : undefined;
    return version === DAEMON_PROTOCOL_VERSION ? "compatible" : "incompatible";
  } catch {
    return "missing";
  }
}

async function stopIncompatibleDaemon(): Promise<void> {
  await withDaemonConnection(async (socket) => {
    await sendAndExpectOk(socket, helloMessage(), { allowProtocolMismatch: true });
    await sendAndExpectOk(socket, { op: "stop" });
  });
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await probeDaemon()) === "missing") return;
    await sleep(CONNECT_RETRY_MS);
  }
  throw new Error("Incompatible mcpxd did not stop before the timeout.");
}

async function connectSocket(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(daemonSocketPath());
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function sendAndExpectOk(
  socket: net.Socket,
  message: ClientMessage,
  options: { allowProtocolMismatch?: boolean } = {},
): Promise<unknown> {
  const response = await requestJsonLine(socket, message);
  if (isDaemonMessage(response) && response.ok) return response.result ?? response;
  if (isDaemonMessage(response) && !response.ok) {
    if (options.allowProtocolMismatch && response.error.code === "protocol-mismatch") {
      return response;
    }
    throw new Error(response.error.message);
  }
  throw new Error("Invalid mcpxd response.");
}

async function sendAndExpectDaemonMessage(
  socket: net.Socket,
  message: ClientMessage,
): Promise<DaemonMessage> {
  const response = await requestJsonLine(socket, message);
  if (isDaemonMessage(response) && response.ok) return response;
  if (isDaemonMessage(response) && !response.ok) throw new Error(response.error.message);
  throw new Error("Invalid mcpxd response.");
}

async function withDaemonConnection<T>(run: (socket: net.Socket) => Promise<T>): Promise<T> {
  const socket = await connectSocket();
  try {
    return await run(socket);
  } finally {
    socket.end();
  }
}

function isDaemonMessage(value: unknown): value is DaemonMessage {
  return !!value && typeof value === "object" && "ok" in value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
