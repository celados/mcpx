import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Stream } from "node:stream";

import { callToolViaDaemon, listToolsViaDaemon } from "./daemon-client";
import { shouldUseDaemon } from "./daemon-protocol";
import { resolveHeaders } from "./headers";
import type { McpTool, ServerConfig, ToolAnnotations } from "./types";
import { MCPX_VERSION } from "./version";

type ListToolsClient = {
  listTools: (params?: { cursor?: string }) => Promise<{
    tools?: RawMcpTool[] | undefined;
    nextCursor?: string | undefined;
  }>;
};

type RawMcpTool = {
  name: string;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: unknown;
  _meta?: unknown;
};

export type McpConnection = {
  client: Client;
  close: () => Promise<void>;
  pid: () => number | null;
  stderr: Stream | null;
  sessionId: () => string | undefined;
  updateHeaders: (headers: Record<string, string>) => void;
};

export type ConnectMcpClientOptions = {
  headers?: Record<string, string> | undefined;
  sessionId?: string | undefined;
  onNotification?: (notification: { method: string; params?: unknown }) => void;
};

export async function withMcpClient<T>(
  server: ServerConfig,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const session = await connectMcpClient(server);

  try {
    return await run(session.client);
  } finally {
    await session.close();
  }
}

export async function connectMcpClient(
  server: ServerConfig,
  options: ConnectMcpClientOptions = {},
): Promise<McpConnection> {
  const client = new Client({ name: "mcpx", version: MCPX_VERSION });
  if (options.onNotification) {
    client.fallbackNotificationHandler = async (notification) => {
      options.onNotification?.(notification);
    };
  }
  const httpHeaders =
    server.transport === "stdio" ? undefined : (options.headers ?? (await resolveHeaders(server)));
  const transport =
    server.transport === "stdio"
      ? new StdioClientTransport(stdioTransportParams(server))
      : new StreamableHTTPClientTransport(
          new URL(server.url),
          httpTransportOptions(httpHeaders, options),
        );

  await client.connect(transport as never);
  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
    pid: () =>
      server.transport === "stdio" && transport instanceof StdioClientTransport
        ? transport.pid
        : null,
    stderr:
      server.transport === "stdio" && transport instanceof StdioClientTransport
        ? transport.stderr
        : null,
    sessionId: () =>
      transport instanceof StreamableHTTPClientTransport ? transport.sessionId : undefined,
    updateHeaders: (headers) => {
      if (!httpHeaders) return;
      for (const key of Object.keys(httpHeaders)) delete httpHeaders[key];
      Object.assign(httpHeaders, headers);
    },
  };
}

function httpTransportOptions(
  headers: Record<string, string> | undefined,
  options: ConnectMcpClientOptions,
): ConstructorParameters<typeof StreamableHTTPClientTransport>[1] {
  const transportOptions: NonNullable<
    ConstructorParameters<typeof StreamableHTTPClientTransport>[1]
  > = {};
  if (headers) transportOptions.requestInit = { headers };
  if (options.sessionId) transportOptions.sessionId = options.sessionId;
  return transportOptions;
}

function stdioTransportParams(server: ServerConfig) {
  if (server.transport !== "stdio") throw new Error("Expected stdio MCP server config.");

  const params: ConstructorParameters<typeof StdioClientTransport>[0] = {
    command: server.command,
    stderr: "pipe",
  };
  if (server.args) params.args = server.args;
  if (server.env) params.env = server.env;
  if (server.cwd) params.cwd = server.cwd;
  return params;
}

export async function listMcpTools(server: ServerConfig, serverName = "stdio"): Promise<McpTool[]> {
  if (shouldUseDaemon()) {
    return listToolsViaDaemon(server, serverName);
  }
  return withMcpClient(server, async (client) => listAllMcpTools(client));
}

export async function listAllMcpTools(client: ListToolsClient): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;

  do {
    const response = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(response.tools ?? []).map(normalizeMcpTool));
    cursor = response.nextCursor;
  } while (cursor);

  return tools;
}

export function normalizeMcpTool(tool: RawMcpTool): McpTool {
  const normalized: McpTool = { name: tool.name };
  if (typeof tool.title === "string") normalized.title = tool.title;
  if (typeof tool.description === "string") normalized.description = tool.description;
  if (tool.inputSchema) normalized.inputSchema = tool.inputSchema;
  if (isToolAnnotations(tool.annotations)) normalized.annotations = tool.annotations;
  if (isRecord(tool._meta)) normalized._meta = tool._meta;
  return normalized;
}

export async function callMcpTool(
  server: ServerConfig,
  toolName: string,
  input: Record<string, unknown>,
  serverName = "stdio",
): Promise<unknown> {
  if (shouldUseDaemon()) {
    return callToolViaDaemon(server, serverName, toolName, input);
  }
  return withMcpClient(server, async (client) =>
    client.callTool({ name: toolName, arguments: input }),
  );
}

function isToolAnnotations(value: unknown): value is ToolAnnotations {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
