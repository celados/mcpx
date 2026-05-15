import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { c, cli, createDefaultSchemaExplorer, group, type Router } from "argc";
import * as v from "valibot";

import { removeServerConfig, upsertServerConfig } from "./config";
import { callMcpTool } from "./mcp-client";
import { discoverServer, refreshServer } from "./discovery";
import { jsonSchemaToStandardSchema } from "./json-schema-standard";
import { assertServerName } from "./names";
import { printOutput, type McpxContext } from "./output";
import { loadProjectService, type ProjectService } from "./project-service";
import {
  isReauthRequiredMessage,
  refreshAllServers,
  startSchemaRefreshWorkerIfNeeded,
} from "./schema-refresh";
import { runSkillCommand } from "./skill-command";
import { removeOAuthToken } from "./token-cache";
import type { ServerConfig } from "./types";
import { MCPX_VERSION } from "./version";

const s = toStandardJsonSchema;

type HandlerOptions<TInput extends Record<string, unknown>> = {
  input: TInput;
  context: McpxContext;
};

const globalInput = s(
  v.object({
    raw: v.optional(v.boolean()),
  }),
);

const addInput = s(
  v.object({
    name: v.pipe(v.string(), v.description("Global server name")),
    url: v.pipe(v.string(), v.url(), v.description("MCP Streamable HTTP endpoint URL")),
    bearerEnv: v.optional(v.string()),
  }),
);

const removeInput = s(
  v.object({
    name: v.pipe(v.string(), v.description("Global server name")),
  }),
);

const skillInput = s(
  v.object({
    servers: v.optional(
      v.pipe(
        v.string(),
        v.description("Comma-separated MCP server names, for example posthog,sentry"),
      ),
    ),
  }),
);

export async function runMcpx(argv: string[], cwd: string, mainPath: string): Promise<void> {
  const service = await loadProjectService();
  const isRefreshCommand = argv.includes("@refresh");
  if (!isRefreshCommand) {
    await refreshMissingSchemas(service);
    await startSchemaRefreshWorkerIfNeeded(service.config, mainPath);
  }

  const app = cli(buildRouter(service), {
    name: "mcpx",
    version: MCPX_VERSION,
    description: "Global MCP registry and agent-facing command surface.",
    globals: globalInput,
    context: (globals) => {
      return { output: globals.raw ? "raw" : "toon" };
    },
    schemaExplorer: createDefaultSchemaExplorer({
      selectionDepth: 2,
      maxLines: 1000,
    }),
  });

  const normalizedArgv = normalizeArgv(argv);
  if (!normalizedArgv) {
    console.error('Invalid option "--json". Use "--raw" to disable output optimization.');
    process.exit(1);
  }

  await app.run({ handlers: buildHandlers(service, cwd) } as never, normalizedArgv);
}

function normalizeArgv(argv: string[]): string[] | null {
  if (argv.some((arg) => arg === "--json" || arg.startsWith("--json="))) return null;
  if (!argv.includes("--raw")) return argv;
  return [...argv.filter((arg) => arg !== "--raw"), "--raw"];
}

function buildRouter(service: ProjectService): Router {
  return {
    ...buildServerRouter(service),
    "@add": c
      .meta({
        description: "Add a global MCP server and discover its auth and tool schema.",
        examples: [
          "mcpx @add --name posthog --url https://mcp.posthog.com/mcp --bearer-env POSTHOG_AUTH_HEADER",
        ],
      })
      .input(addInput),
    "@remove": c
      .meta({
        description: "Remove a global MCP server and its cached credentials.",
        examples: ["mcpx @remove --name posthog"],
      })
      .input(removeInput),
    "@refresh": c.meta({
      description: "Refresh all registered MCP server schemas and report auth status.",
      examples: ["mcpx @refresh"],
    }),
    "@skill": c
      .meta({
        description:
          "Generate a project skill that teaches agents which global MCP servers to use.",
        examples: ["mcpx @skill", "mcpx @skill --servers posthog,sentry"],
      })
      .input(skillInput),
  };
}

function buildServerRouter(service: ProjectService): Record<string, Router> {
  const servers: Record<string, Router> = {};
  for (const [serverName, server] of Object.entries(service.config.servers)) {
    const tools = server.tools ?? [];
    const children: Record<string, Router> = {};
    for (const tool of tools) {
      children[tool.commandName] = c
        .meta({
          description: describeTool(tool, serverName),
        })
        .input(jsonSchemaToStandardSchema(tool.inputSchema));
    }
    servers[serverName] = group({ description: describeServerTools(tools.length) }, children);
  }
  return servers;
}

function describeServerTools(count: number): string {
  return `(${count} ${count === 1 ? "tool" : "tools"})`;
}

function describeTool(
  tool: {
    name: string;
    title?: string;
    description?: string;
    annotations?: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
  },
  serverName: string,
): string {
  const parts: string[] = [];
  if (tool.title) parts.push(tool.title);
  parts.push(tool.description ?? `Call ${serverName}.${tool.name}`);

  const hints = toolAnnotationHints(tool.annotations);
  if (hints.length > 0) parts.push(`[${hints.join(", ")}]`);
  return parts.join(" — ");
}

function toolAnnotationHints(
  annotations:
    | {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      }
    | undefined,
): string[] {
  if (!annotations) return [];
  const hints: string[] = [];
  if (annotations.readOnlyHint) hints.push("read-only");
  if (annotations.destructiveHint) hints.push("destructive");
  if (annotations.idempotentHint) hints.push("idempotent");
  if (annotations.openWorldHint === false) hints.push("closed-world");
  return hints;
}

function buildHandlers(service: ProjectService, cwd: string): Record<string, unknown> {
  const handlers: Record<string, unknown> = {};

  for (const [serverName, server] of Object.entries(service.config.servers)) {
    const serverHandlers: Record<string, unknown> = {};
    for (const tool of server.tools ?? []) {
      serverHandlers[tool.commandName] = async (
        options: HandlerOptions<Record<string, unknown>>,
      ) => {
        const readyServer = await service.ensureServerReady(serverName);
        const result = await callToolWithReauthRetry(
          service,
          serverName,
          readyServer,
          tool.name,
          options.input,
        );
        await printOutput(result, options.context);
      };
    }
    handlers[serverName] = serverHandlers;
  }

  handlers["@add"] = async (
    options: HandlerOptions<{ name: string; url: string; bearerEnv?: string }>,
  ) => {
    const input = options.input;
    const name = assertServerName(input.name);
    const discoverOptions: { url: string; bearerEnv?: string } = {
      url: input.url,
    };
    if (input.bearerEnv) discoverOptions.bearerEnv = input.bearerEnv;
    const result = await discoverServer({ ...discoverOptions, name });
    await upsertServerConfig(name, result.server);
    await printOutput(
      {
        name,
        status: result.status,
        auth: result.server.auth,
        tools: result.server.tools?.length ?? 0,
        message: result.message,
      },
      options.context,
    );
  };

  handlers["@remove"] = async (options: HandlerOptions<{ name: string }>) => {
    const name = assertServerName(options.input.name);
    const removed = await removeServerConfig(name);
    if (!removed) {
      throw new Error(`Unknown MCP server "${name}".`);
    }
    const tokenRemoved =
      removed.auth.kind === "oauth-token" ? await removeOAuthToken(removed.auth.tokenKey) : false;
    await printOutput(
      {
        name,
        removed: true,
        tokenRemoved,
      },
      options.context,
    );
  };

  handlers["@refresh"] = async (options: HandlerOptions<Record<string, never>>) => {
    await printOutput(await refreshAllServers(), options.context);
  };

  handlers["@skill"] = async (options: HandlerOptions<{ servers?: string }>) => {
    await runSkillCommand(service, cwd, options.input);
  };

  return handlers;
}

async function callToolWithReauthRetry(
  service: ProjectService,
  serverName: string,
  server: ServerConfig,
  toolName: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await callMcpTool(server, toolName, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isReauthRequiredMessage(message)) throw error;
    const reauthenticated = await service.reauthenticateServer(serverName);
    return callMcpTool(reauthenticated, toolName, input);
  }
}

async function refreshMissingSchemas(service: ProjectService): Promise<void> {
  let changed = false;

  for (const [name, server] of Object.entries(service.config.servers)) {
    if (server.tools && server.tools.length > 0) continue;
    try {
      service.config.servers[name] = await refreshServer(server);
      changed = true;
    } catch {
      // Keep startup usable when auth is not available yet; add/discover records
      // the auth state so the next run can retry after credentials are configured.
    }
  }

  if (changed) {
    await service.save();
  }
}

export const __test = {
  buildServerRouter,
  buildRouter,
  buildHandlers,
  describeServerTools,
  describeTool,
  normalizeArgv,
};
