import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { discoverAuth } from "./auth-discovery";
import { readRegistryConfig, writeRegistryConfig } from "./config";
import { reauthenticateServer, refreshServer } from "./discovery";
import { resolveHeaders } from "./headers";
import { getOAuthToken } from "./token-cache";
import type { OAuthToken, RegistryConfig, ServerConfig, ServerRefreshStatus } from "./types";

const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const STALE_LOCK_AFTER_MS = 10 * 60 * 1000;
const LOCK_PATH = path.join(homedir(), ".agents", "mcpx", "schema-refresh.lock");
const WORKER_ENV = "MCPX_SCHEMA_REFRESH_WORKER";

export type ServerRefreshResult = {
  server: string;
  status:
    | "schema-refreshed"
    | "auth-refreshed"
    | "reauthenticated"
    | "reauth-required"
    | "unreachable";
  toolsBefore: number;
  toolsAfter?: number;
  schemaChanged?: boolean;
  message?: string;
};

export type RefreshSummary = {
  checkedAt: string;
  refreshed: string[];
  unchanged: string[];
  authRefreshed: string[];
  reauthenticated: string[];
  reauthRequired: string[];
  unreachable: string[];
  servers: ServerRefreshResult[];
};

export function isSchemaRefreshStale(server: ServerConfig, now: Date = new Date()): boolean {
  if (!server.tools || server.tools.length === 0) return false;
  if (!server.discoveredAt) return true;

  const discoveredAt = Date.parse(server.discoveredAt);
  if (!Number.isFinite(discoveredAt)) return true;

  return now.getTime() - discoveredAt >= REFRESH_AFTER_MS;
}

export function hasStaleSchemas(config: RegistryConfig, now: Date = new Date()): boolean {
  return Object.values(config.servers).some((server) => isSchemaRefreshStale(server, now));
}

export async function startSchemaRefreshWorkerIfNeeded(
  config: RegistryConfig,
  mainPath: string,
): Promise<void> {
  if (process.env[WORKER_ENV]) return;
  if (!hasStaleSchemas(config)) return;
  if (await isLockActive()) return;

  const subprocess = Bun.spawn([process.execPath, mainPath], {
    env: {
      ...process.env,
      [WORKER_ENV]: "1",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  subprocess.unref();
}

export function shouldRunSchemaRefreshWorker(): boolean {
  return process.env[WORKER_ENV] === "1";
}

export async function runSchemaRefreshWorker(): Promise<void> {
  await withRefreshLock(async () => {
    const initialConfig = await readRegistryConfig();
    const staleNames = Object.entries(initialConfig.servers)
      .filter((entry) => isSchemaRefreshStale(entry[1]))
      .map((entry) => entry[0]);

    for (const name of staleNames) {
      await refreshOneServer(name, { staleOnly: true, interactiveAuth: false });
    }
  });
}

export async function refreshAllServers(): Promise<RefreshSummary> {
  const config = await readRegistryConfig();
  const results: ServerRefreshResult[] = [];

  for (const name of Object.keys(config.servers)) {
    results.push(await refreshOneServer(name, { staleOnly: false, interactiveAuth: true }));
  }

  return buildRefreshSummary(results);
}

async function refreshOneServer(
  name: string,
  options: { staleOnly: boolean; interactiveAuth: boolean },
): Promise<ServerRefreshResult> {
  const beforeRefresh = await readRegistryConfig();
  const server = beforeRefresh.servers[name];
  if (!server) {
    return {
      server: name,
      status: "unreachable",
      toolsBefore: 0,
      message: "Server was removed before refresh started.",
    };
  }

  const toolsBefore = server.tools?.length ?? 0;
  if (options.staleOnly && !isSchemaRefreshStale(server)) {
    return {
      server: name,
      status: "schema-refreshed",
      toolsBefore,
      toolsAfter: toolsBefore,
      schemaChanged: false,
    };
  }

  const authResult = await ensureAuthReady(name, server, toolsBefore, options.interactiveAuth);
  if (authResult.status !== "ready") return authResult.result;

  const readyServer = authResult.server;
  let refreshed: ServerConfig;
  try {
    refreshed = await refreshServer(readyServer);
  } catch (error) {
    return writeFailureResult(name, readyServer, toolsBefore, error);
  }
  const beforeWrite = await readRegistryConfig();
  const current = beforeWrite.servers[name];
  if (!current || !isSameRefreshTarget(readyServer, current)) {
    return {
      server: name,
      status: "unreachable",
      toolsBefore,
      message: "Server changed before refresh completed.",
    };
  }

  const toolsAfter = refreshed.tools?.length ?? 0;
  const schemaChanged =
    JSON.stringify(readyServer.tools ?? []) !== JSON.stringify(refreshed.tools ?? []);
  const status = authResult.authStatus === "none" ? "schema-refreshed" : authResult.authStatus;
  const result: ServerRefreshResult = {
    server: name,
    status,
    toolsBefore,
    toolsAfter,
    schemaChanged,
  };

  // Refreshing can take longer than a foreground registry edit. Re-read before
  // writing so a background worker does not resurrect a removed server.
  beforeWrite.servers[name] = {
    ...refreshed,
    refreshStatus: refreshStatusFromResult(result),
  };
  await writeRegistryConfig(beforeWrite);
  return result;
}

type AuthReadyResult =
  | {
      status: "ready";
      server: ServerConfig;
      authStatus: "none" | "auth-refreshed" | "reauthenticated";
    }
  | { status: "blocked"; result: ServerRefreshResult };

async function ensureAuthReady(
  name: string,
  server: ServerConfig,
  toolsBefore: number,
  interactiveAuth: boolean,
): Promise<AuthReadyResult> {
  if (server.auth.kind === "oauth") {
    if (!interactiveAuth) {
      const result: ServerRefreshResult = {
        server: name,
        status: "reauth-required",
        toolsBefore,
        message: "OAuth authentication is required. Run mcpx @refresh in an interactive shell.",
      };
      await writeRefreshStatus(name, server, refreshStatusFromResult(result));
      return { status: "blocked", result };
    }
    return reauthenticateOneServer(name, server, toolsBefore);
  }

  const tokenBefore = await readOAuthToken(server);
  let headers: Record<string, string>;
  try {
    headers = await resolveHeaders(server);
  } catch (error) {
    if (interactiveAuth && isReauthRequiredMessage(errorMessage(error))) {
      return reauthenticateOneServer(name, server, toolsBefore);
    }
    const result = await writeFailureResult(name, server, toolsBefore, error);
    return { status: "blocked", result };
  }
  const auth = await discoverAuth(new URL(server.url), headers);
  if (auth.kind === "oauth") {
    if (interactiveAuth) return reauthenticateOneServer(name, server, toolsBefore);
    const result: ServerRefreshResult = {
      server: name,
      status: "reauth-required",
      toolsBefore,
      message: "OAuth authentication is required. Run mcpx @refresh in an interactive shell.",
    };
    await writeRefreshStatus(name, server, refreshStatusFromResult(result));
    return { status: "blocked", result };
  }
  if (auth.kind === "unknown") {
    const result: ServerRefreshResult = {
      server: name,
      status: "unreachable",
      toolsBefore,
      message: auth.reason,
    };
    await writeRefreshStatus(name, server, refreshStatusFromResult(result));
    return { status: "blocked", result };
  }
  const tokenAfter = await readOAuthToken(server);
  const authChanged = tokenChanged(tokenBefore, tokenAfter);
  const currentConfig = await readRegistryConfig();
  const current = currentConfig.servers[name];
  return {
    status: "ready",
    server: current && isSameRefreshTarget(server, current) ? current : server,
    authStatus: authChanged ? "auth-refreshed" : "none",
  };
}

async function reauthenticateOneServer(
  name: string,
  server: ServerConfig,
  toolsBefore: number,
): Promise<AuthReadyResult> {
  let reauthenticated: ServerConfig;
  try {
    reauthenticated = await reauthenticateServer(name, server);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: ServerRefreshResult = {
      server: name,
      status: isReauthRequiredMessage(message) ? "reauth-required" : "unreachable",
      toolsBefore,
      message,
    };
    await writeRefreshStatus(name, server, refreshStatusFromResult(result));
    return { status: "blocked", result };
  }

  const beforeWrite = await readRegistryConfig();
  const current = beforeWrite.servers[name];
  if (!current || !isSameRefreshTarget(server, current)) {
    const result: ServerRefreshResult = {
      server: name,
      status: "unreachable",
      toolsBefore,
      message: "Server changed before re-authentication completed.",
    };
    return { status: "blocked", result };
  }

  beforeWrite.servers[name] = {
    ...reauthenticated,
    refreshStatus: {
      checkedAt: new Date().toISOString(),
      status: "ok",
    },
  };
  await writeRegistryConfig(beforeWrite);
  return { status: "ready", server: reauthenticated, authStatus: "reauthenticated" };
}

async function writeFailureResult(
  name: string,
  server: ServerConfig,
  toolsBefore: number,
  error: unknown,
): Promise<ServerRefreshResult> {
  const message = errorMessage(error);
  const result: ServerRefreshResult = {
    server: name,
    status: isReauthRequiredMessage(message) ? "reauth-required" : "unreachable",
    toolsBefore,
    message,
  };
  await writeRefreshStatus(name, server, refreshStatusFromResult(result));
  return result;
}

function isSameRefreshTarget(left: ServerConfig, right: ServerConfig): boolean {
  return (
    left.url === right.url &&
    JSON.stringify(left.headers ?? null) === JSON.stringify(right.headers ?? null) &&
    JSON.stringify(left.auth) === JSON.stringify(right.auth)
  );
}

async function writeRefreshStatus(
  name: string,
  server: ServerConfig,
  status: ServerRefreshStatus,
): Promise<void> {
  const config = await readRegistryConfig();
  const current = config.servers[name];
  if (!current || !isSameRefreshTarget(server, current)) return;
  config.servers[name] = {
    ...current,
    refreshStatus: status,
  };
  await writeRegistryConfig(config);
}

function refreshStatusFromResult(result: ServerRefreshResult): ServerRefreshStatus {
  const status =
    result.status === "reauth-required"
      ? "reauth-required"
      : result.status === "unreachable"
        ? "unreachable"
        : "ok";
  const refreshStatus: ServerRefreshStatus = {
    checkedAt: new Date().toISOString(),
    status,
  };
  if (result.message) refreshStatus.message = result.message;
  return refreshStatus;
}

export function buildRefreshSummary(results: ServerRefreshResult[]): RefreshSummary {
  return {
    checkedAt: new Date().toISOString(),
    refreshed: results
      .filter(
        (result) =>
          (result.status === "schema-refreshed" ||
            result.status === "auth-refreshed" ||
            result.status === "reauthenticated") &&
          result.schemaChanged === true,
      )
      .map((result) => result.server),
    unchanged: results
      .filter(
        (result) =>
          (result.status === "schema-refreshed" ||
            result.status === "auth-refreshed" ||
            result.status === "reauthenticated") &&
          result.schemaChanged === false,
      )
      .map((result) => result.server),
    authRefreshed: results
      .filter((result) => result.status === "auth-refreshed")
      .map((result) => result.server),
    reauthenticated: results
      .filter((result) => result.status === "reauthenticated")
      .map((result) => result.server),
    reauthRequired: results
      .filter((result) => result.status === "reauth-required")
      .map((result) => result.server),
    unreachable: results
      .filter((result) => result.status === "unreachable")
      .map((result) => result.server),
    servers: results,
  };
}

async function readOAuthToken(server: ServerConfig): Promise<OAuthToken | undefined> {
  if (server.auth.kind !== "oauth-token") return undefined;
  return getOAuthToken(server.auth.tokenKey);
}

function tokenChanged(left: OAuthToken | undefined, right: OAuthToken | undefined): boolean {
  if (!left || !right) return false;
  return JSON.stringify(left) !== JSON.stringify(right);
}

export function isReauthRequiredMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    message.includes("Run mcpx @add again") ||
    message.includes("OAuth token refresh failed") ||
    message.includes("OAuth client secret is missing") ||
    normalized.includes("invalid_token") ||
    normalized.includes("unauthorized") ||
    normalized.includes("http 401")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withRefreshLock<T>(callback: () => Promise<T>): Promise<T | undefined> {
  await clearStaleLock();
  let lock: fs.FileHandle | undefined;
  try {
    await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });
    lock = await fs.open(LOCK_PATH, "wx");
    await lock.writeFile(
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    return await callback();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  } finally {
    await lock?.close();
    if (lock) {
      await fs.rm(LOCK_PATH, { force: true });
    }
  }
}

async function isLockActive(): Promise<boolean> {
  await clearStaleLock();
  try {
    await fs.access(LOCK_PATH);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

async function clearStaleLock(): Promise<void> {
  try {
    const stat = await fs.stat(LOCK_PATH);
    if (Date.now() - stat.mtimeMs > STALE_LOCK_AFTER_MS) {
      await fs.rm(LOCK_PATH, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
