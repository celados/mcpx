import type {
	AuthDiscovery,
	DiscoveryResult,
	McpTool,
	ServerConfig,
	ToolDefinition,
} from './types'

import { authFromBearerValues, describeBearerAuth } from './bearer'
import { authorizationChallenge, listMcpTools } from './mcp-client'
import { assignCommandNames } from './names'

export type DiscoverServerOptions = {
	name: string
} & (
	| {
			transport?: 'http'
			url: string
			bearer?: string | string[]
			headers?: Record<string, string>
	  }
	| {
			transport: 'stdio'
			command: string
			args?: string[]
			env?: Record<string, string>
	  }
)

export async function discoverServer(
	options: DiscoverServerOptions,
): Promise<DiscoveryResult> {
	if (options.transport === 'stdio') return discoverStdioServer(options)

	const url = new URL(options.url)
	const configuredAuth = authFromBearerValues(options.bearer)
	const server: ServerConfig = {
		transport: 'http',
		url: url.toString(),
		auth: configuredAuth ?? { kind: 'none' },
		discoveredAt: new Date().toISOString(),
	}
	if (options.headers) server.headers = options.headers

	try {
		const tools = await listMcpTools(server, options.name)
		server.tools = normalizeTools(tools)
		return {
			server,
			status: 'ready',
			message: `Discovered ${server.tools.length} tool(s).`,
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		// The challenge, not a probe, says the server wants OAuth (ADR 0009).
		// @add never starts OAuth, so name the commands that do.
		if (!configuredAuth && authorizationChallenge(error)) {
			server.auth = { kind: 'oauth' }
			return {
				server,
				status: 'auth-required',
				message:
					'Authentication is required before tool schemas can be listed. Run `mcpx @refresh` or call a tool to authenticate.',
			}
		}
		if (configuredAuth && authorizationChallenge(error)) {
			return {
				server,
				status: 'auth-required',
				message: `The configured bearer credential was rejected. ${message}`,
			}
		}
		return { server, status: 'unreachable', message }
	}
}

async function discoverStdioServer(
	options: DiscoverServerOptions & { transport: 'stdio' },
): Promise<DiscoveryResult> {
	const seedServer: ServerConfig = {
		transport: 'stdio',
		command: options.command,
	}
	if (options.args) seedServer.args = options.args
	if (options.env) seedServer.env = options.env

	const server: ServerConfig = {
		...seedServer,
		discoveredAt: new Date().toISOString(),
	}

	try {
		const tools = await listMcpTools(server, options.name)
		server.tools = normalizeTools(tools)
		return {
			server,
			status: 'ready',
			message: `Discovered ${server.tools.length} tool(s).`,
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return { server, status: 'unreachable', message }
	}
}

export function normalizeTools(tools: McpTool[]): ToolDefinition[] {
	const names = tools.map((tool) => tool.name)
	const commandNames = assignCommandNames(names)
	return tools.map((tool) => {
		const normalized: ToolDefinition = {
			name: tool.name,
			commandName: commandNames.get(tool.name) ?? tool.name,
		}
		if (tool.title) normalized.title = tool.title
		if (tool.description) normalized.description = tool.description
		if (isJsonSchema(tool.inputSchema))
			normalized.inputSchema = tool.inputSchema
		if (tool.annotations) normalized.annotations = tool.annotations
		if (tool._meta) normalized._meta = tool._meta
		return normalized
	})
}

export function describeAuth(auth: AuthDiscovery): string {
	switch (auth.kind) {
		case 'none':
			return 'none'
		case 'bearer':
			return describeBearerAuth(auth)
		case 'oauth':
			return 'oauth'
	}
}

function isJsonSchema(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}
