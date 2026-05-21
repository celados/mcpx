import { createHash } from "node:crypto";

import type { ServerConfig } from "./types";
import { MCPX_VERSION } from "./version";

export const DAEMON_PROTOCOL_VERSION = 2;
export const DAEMON_ENV = "MCPX_DAEMON_SERVER";
export const DISABLE_DAEMON_ENV = "MCPX_DISABLE_DAEMON";

export type McpNotification =
  | {
      method: "notifications/progress";
      params: {
        progressToken: string | number;
        progress: number;
        total?: number;
        message?: string;
      };
      aggregatedCount?: number;
    }
  | { method: "notifications/tools/list_changed"; params?: unknown }
  | { method: "$oversize"; params: { savedTo: string } }
  | { method: string; params?: unknown };

export type DaemonStatus = {
  pid: number;
  protocolVersion: number;
  version: string;
  activeServers: number;
  servers: {
    serverKey: string;
    transport: "stdio" | "http";
    labels: string[];
    pid?: number | null;
    url?: string;
    activeCalls: number;
    queuedCalls: number;
    idleMs: number;
    evictCount: number;
    hasRetainedSessionId: boolean;
    sessionIdHash?: string;
  }[];
};

export type ClientMessage =
  | { op: "hello"; protocolVersion: number; clientVersion: string }
  | {
      op: "listTools";
      callId: string;
      serverName: string;
      serverKey: string;
      server: ServerConfig;
      headers?: Record<string, string>;
    }
  | {
      op: "call";
      callId: string;
      serverName: string;
      serverKey: string;
      server: ServerConfig;
      headers?: Record<string, string>;
      toolName: string;
      input: Record<string, unknown>;
      notificationMode?: "buffer" | "discard";
    }
  | { op: "status" }
  | { op: "stop" }
  | {
      op: "evictSession";
      serverKey: string;
      reason?: "auth-refreshed" | "unauthorized" | "manual";
    };

export type DaemonMessage =
  | {
      ok: true;
      protocolVersion?: number;
      result?: unknown;
      notifications?: McpNotification[];
      toolsChanged?: boolean;
    }
  | { ok: false; error: { code: string; message: string } };

export function shouldUseDaemon(): boolean {
  return process.env[DAEMON_ENV] !== "1" && process.env[DISABLE_DAEMON_ENV] !== "1";
}

export function buildServerKey(server: ServerConfig): string {
  const payload =
    server.transport === "stdio"
      ? stableJson({
          command: server.command,
          args: server.args ?? [],
          env: server.env ?? {},
          cwd: server.cwd ?? null,
        })
      : stableJson({
          type: "http",
          url: server.url,
          authKind: server.auth?.kind ?? null,
          authRef:
            server.auth?.kind === "bearer"
              ? server.auth.env
              : server.auth?.kind === "oauth-token"
                ? server.auth.tokenKey
                : null,
        });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function helloMessage(): ClientMessage {
  return {
    op: "hello",
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    clientVersion: MCPX_VERSION,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortValue(record[key]);
  }
  return sorted;
}
