import {
	cancel,
	confirm,
	isCancel,
	multiselect,
	note,
	password,
	text,
} from '@clack/prompts'
import { toStandardJsonSchema } from '@valibot/to-json-schema'
import {
	c,
	cli,
	createDefaultSchemaExplorer,
	domainError,
	group,
	type Router,
} from 'argc'
import * as v from 'valibot'

import type { RuntimeInputRequest, RuntimeIntent } from './runtime-protocol'
import type { RuntimeRegistrySnapshot } from './runtime-stores'
import type { RegistryView } from './skill-command'
import type { RegistryConfig } from './types'

import { notificationModeFromEnv } from './daemon-protocol'
import { daemonOutputEnvelope } from './daemon-result'
import { runDaemonServer } from './daemon-server'
import { jsonSchemaToStandardSchema } from './json-schema-standard'
import { assertServerName } from './names'
import { renderOutput, type McpxContext } from './output'
import { requestRuntime } from './runtime-client'
import { runSkillCommand } from './skill-command'
import { embedSkill } from './skill.embed.ts' with { type: 'macro' }
import { MCPX_VERSION } from './version'

const s = toStandardJsonSchema

type HandlerOptions<TInput extends Record<string, unknown>> = {
	input: TInput
	context: McpxContext
}

type AddServerInput = {
	name: string
	transport?: 'http' | 'stdio'
	url?: string
	bearer?: string | string[]
	command?: string
	args?: string | string[]
	env?: Record<string, string>
}

const outputContext = s(
	v.object({
		output: v.optional(v.picklist(['optimized', 'raw']), 'optimized'),
	}),
)

const addInput = s(
	v.object({
		name: v.pipe(v.string(), v.description('Global server name')),
		transport: v.optional(v.picklist(['http', 'stdio'])),
		url: v.optional(
			v.pipe(
				v.string(),
				v.url(),
				v.description('MCP Streamable HTTP endpoint URL'),
			),
		),
		bearer: v.optional(v.union([v.string(), v.array(v.string())])),
		command: v.optional(
			v.pipe(v.string(), v.description('Stdio MCP server command')),
		),
		args: v.optional(v.union([v.string(), v.array(v.string())])),
		env: v.optional(v.record(v.string(), v.string())),
	}),
)

const removeInput = s(
	v.object({
		name: v.optional(
			v.pipe(
				v.string(),
				v.description(
					'Global server name(s). Comma-separated for multiple. Omit to pick interactively.',
				),
			),
		),
	}),
)

const skillInput = s(
	v.object({
		servers: v.optional(
			v.pipe(
				v.string(),
				v.description(
					'Comma-separated MCP server names, for example posthog,sentry',
				),
			),
		),
		show: v.optional(
			v.pipe(
				v.string(),
				v.description(
					'Print a temporary skill for one MCP server without writing files',
				),
			),
		),
	}),
)

export async function runMcpx(
	argv: string[],
	cwd: string,
	mainPath: string,
): Promise<void> {
	const snapshot = (await requestRuntime(
		{ requestId: crypto.randomUUID(), op: 'registrySnapshot' },
		mainPath,
	)) as RuntimeRegistrySnapshot
	const registry: RegistryView = {
		servers: snapshot.servers as unknown as RegistryConfig['servers'],
	}

	const app = cli(buildRouter(registry), {
		name: 'mcpx',
		version: MCPX_VERSION,
		description: 'Global MCP registry and agent-facing command surface.',
		context: outputContext,
		schemaExplorer: createDefaultSchemaExplorer({
			selectionDepth: 2,
			maxLines: 1000,
		}),
		skill: embedSkill(),
	})

	await app.run(
		{ handlers: buildHandlers(registry, cwd, mainPath) } as never,
		argv,
	)
}

function buildRouter(registry: RegistryView): Router {
	return {
		...buildServerRouter(registry),
		'@add': c
			.meta({
				description:
					'Add a global MCP server and discover its auth and tool schema.',
				examples: [
					`mcpx @add "{ name: 'posthog', url: 'https://mcp.posthog.com/mcp', bearer: 'env:POSTHOG_AUTH_HEADER' }"`,
					`mcpx @add "{ name: 'open-design', transport: 'stdio', command: 'node', args: ['/path/to/open-design/apps/daemon/dist/cli.js', 'mcp'] }"`,
				],
			})
			.input(addInput),
		'@remove': c
			.meta({
				description: 'Remove a global MCP server and its cached credentials.',
				examples: [
					`mcpx @remove "{ name: 'posthog' }"`,
					`mcpx @remove "{ name: 'posthog,sentry' }"`,
					'mcpx @remove',
				],
			})
			.input(removeInput),
		'@refresh': c.meta({
			description:
				'Refresh all registered MCP server schemas and report auth status.',
			examples: ['mcpx @refresh'],
		}),
		'@daemon': group(
			{ description: 'Inspect or stop the local mcpxd daemon.' },
			{
				status: c.meta({
					description: 'Show local mcpxd daemon status.',
					examples: ['mcpx @daemon.status'],
				}),
				stop: c.meta({
					description: 'Stop local mcpxd and its managed stdio MCP processes.',
					examples: ['mcpx @daemon.stop'],
				}),
				server: c.meta({
					description: 'Run the local mcpxd daemon server.',
					examples: ['mcpx @daemon.server'],
				}),
			},
		),
		'@skill-install': c
			.meta({
				description:
					'Generate a project skill or print a temporary server skill for agents.',
				examples: [
					'mcpx @skill-install',
					`mcpx @skill-install "{ servers: 'posthog,sentry' }"`,
					`mcpx @skill-install "{ show: 'slack' }"`,
				],
			})
			.input(skillInput),
	}
}

function buildServerRouter(registry: RegistryView): Record<string, Router> {
	const servers: Record<string, Router> = {}
	for (const [serverName, server] of Object.entries(registry.servers)) {
		const tools = server.tools ?? []
		const children: Record<string, Router> = {}
		for (const tool of tools) {
			children[tool.commandName] = c
				.meta({
					description: describeTool(tool, serverName),
				})
				.input(jsonSchemaToStandardSchema(tool.inputSchema))
		}
		servers[serverName] = group(
			{ description: describeServerTools(tools.length) },
			children,
		)
	}
	return servers
}

function describeServerTools(count: number): string {
	return `(${count} ${count === 1 ? 'tool' : 'tools'})`
}

function describeTool(
	tool: {
		name: string
		title?: string
		description?: string
		annotations?: {
			readOnlyHint?: boolean
			destructiveHint?: boolean
			idempotentHint?: boolean
			openWorldHint?: boolean
		}
	},
	serverName: string,
): string {
	const parts: string[] = []
	if (tool.title) parts.push(tool.title)
	parts.push(tool.description ?? `Call ${serverName}.${tool.name}`)

	const hints = toolAnnotationHints(tool.annotations)
	if (hints.length > 0) parts.push(`[${hints.join(', ')}]`)
	return parts.join(' — ')
}

function toolAnnotationHints(
	annotations:
		| {
				readOnlyHint?: boolean
				destructiveHint?: boolean
				idempotentHint?: boolean
				openWorldHint?: boolean
		  }
		| undefined,
): string[] {
	if (!annotations) return []
	const hints: string[] = []
	if (annotations.readOnlyHint) hints.push('read-only')
	if (annotations.destructiveHint) hints.push('destructive')
	if (annotations.idempotentHint) hints.push('idempotent')
	if (annotations.openWorldHint === false) hints.push('closed-world')
	return hints
}

function buildHandlers(
	registry: RegistryView,
	cwd: string,
	mainPath = process.argv[1] ?? '',
): Record<string, unknown> {
	const handlers: Record<string, unknown> = {}

	for (const [serverName, server] of Object.entries(registry.servers)) {
		const serverHandlers: Record<string, unknown> = {}
		for (const tool of server.tools ?? []) {
			serverHandlers[tool.commandName] = async (
				options: HandlerOptions<Record<string, unknown>>,
			) => {
				let result: unknown
				try {
					result = await requestRuntime(
						{
							requestId: crypto.randomUUID(),
							op: 'call',
							serverName,
							toolName: tool.name,
							input: options.input,
							notificationMode: notificationModeFromEnv(),
						},
						mainPath,
					)
				} catch (error) {
					throw domainError(
						'MCP_CALL_FAILED',
						error instanceof Error ? error.message : String(error),
						{ server: serverName, tool: tool.name },
					)
				}
				return await renderOutput(runtimeCallOutput(result), options.context)
			}
		}
		handlers[serverName] = serverHandlers
	}

	handlers['@add'] = async (options: HandlerOptions<AddServerInput>) => {
		const input = options.input
		const name = assertServerName(input.name)
		const discovered = addDiscoverOptions(name, input)
		const intent: Extract<RuntimeIntent, { op: 'addServer' }> = {
			requestId: crypto.randomUUID(),
			op: 'addServer',
			serverName: name,
			transport: discovered.transport,
		}
		if (discovered.transport === 'stdio') {
			intent.command = discovered.command
			if (discovered.args) intent.args = discovered.args
			if (discovered.env) intent.env = discovered.env
		} else {
			intent.url = discovered.url
			const bearer = normalizeStringList(discovered.bearer)
			if (bearer) intent.bearer = bearer
		}
		return await renderOutput(
			await requestRuntime(intent, mainPath),
			options.context,
		)
	}

	handlers['@remove'] = async (options: HandlerOptions<{ name?: string }>) => {
		const rawName = options.input.name
		const names =
			rawName === undefined
				? await promptForServersToRemove(registry)
				: parseRemoveNames(rawName)

		return await renderOutput(
			await requestRuntime(
				{
					requestId: crypto.randomUUID(),
					op: 'removeServers',
					serverNames: names,
				},
				mainPath,
			),
			options.context,
		)
	}

	handlers['@refresh'] = async (
		options: HandlerOptions<Record<string, never>>,
	) => {
		return await renderOutput(
			await requestRuntime(
				{ requestId: crypto.randomUUID(), op: 'refreshServers' },
				mainPath,
				{ onInput: promptForRuntimeInput },
			),
			options.context,
		)
	}

	handlers['@daemon'] = {
		status: async (options: HandlerOptions<Record<string, never>>) => {
			return await renderOutput(
				await requestRuntime(
					{ requestId: crypto.randomUUID(), op: 'status' },
					mainPath,
				),
				options.context,
			)
		},
		stop: async (options: HandlerOptions<Record<string, never>>) => {
			return await renderOutput(
				await requestRuntime(
					{ requestId: crypto.randomUUID(), op: 'stop' },
					mainPath,
					{ start: false },
				),
				options.context,
			)
		},
		server: async (_options: HandlerOptions<Record<string, never>>) => {
			await runDaemonServer()
		},
	}

	handlers['@skill-install'] = async (
		options: HandlerOptions<{ servers?: string; show?: string }>,
	) => {
		return await runSkillCommand(registry, cwd, options.input)
	}

	return handlers
}

async function promptForRuntimeInput(
	request: RuntimeInputRequest,
	signal: AbortSignal,
): Promise<unknown> {
	if (request.type !== 'oauth-client') {
		return { cancelled: true, reason: 'Unsupported Runtime input request.' }
	}
	if (!process.stdin.isTTY) {
		return { cancelled: true, reason: 'Interactive terminal required.' }
	}
	note(
		[
			'This OAuth server does not support dynamic client registration.',
			'Add and save this exact Redirect URL in the provider app settings.',
			`Redirect URL: ${request.redirectUri}`,
			`Authorization server: ${request.issuer}`,
			request.scopes.length
				? `Requested scopes: ${request.scopes.join(', ')}`
				: '',
		]
			.filter(Boolean)
			.join('\n'),
		`${request.serverName} OAuth client`,
	)
	const configured = await confirm({
		message: 'I have added and saved this exact Redirect URL',
		initialValue: false,
		signal,
	})
	if (isCancel(configured) || !configured) return { cancelled: true }
	const clientId = await text({
		message: 'OAuth client_id',
		signal,
		validate: (value) => (value?.trim() ? undefined : 'client_id is required.'),
	})
	if (isCancel(clientId)) return { cancelled: true }
	const clientSecret = await password({
		message: 'OAuth client_secret',
		signal,
		validate: (value) =>
			value?.trim() ? undefined : 'client_secret is required.',
	})
	if (isCancel(clientSecret)) return { cancelled: true }
	return { clientId: clientId.trim(), clientSecret: clientSecret.trim() }
}

function runtimeCallOutput(value: unknown): unknown {
	if (!value || typeof value !== 'object' || !('result' in value)) return value
	const response = value as {
		result: unknown
		notifications?: Parameters<typeof daemonOutputEnvelope>[0]['notifications']
		toolsChanged?: boolean
	}
	if (response.notifications?.length || response.toolsChanged) {
		return daemonOutputEnvelope({
			result: response.result,
			notifications: response.notifications ?? [],
			toolsChanged: response.toolsChanged === true,
		})
	}
	return response.result
}

function addDiscoverOptions(name: string, input: AddServerInput) {
	if (input.transport === 'stdio' || input.command) {
		if (!input.command) {
			throw new Error('Stdio MCP servers require "--command".')
		}
		const options: {
			name: string
			transport: 'stdio'
			command: string
			args?: string[]
			env?: Record<string, string>
		} = {
			name,
			transport: 'stdio' as const,
			command: input.command,
		}
		const args = normalizeStringList(input.args)
		if (args) options.args = args
		if (input.env) options.env = input.env
		return options
	}

	if (!input.url) {
		throw new Error('HTTP MCP servers require "--url".')
	}

	const options: {
		name: string
		transport: 'http'
		url: string
		bearer?: string | string[]
	} = {
		name,
		transport: 'http',
		url: input.url,
	}
	if (input.bearer) options.bearer = input.bearer
	return options
}

function normalizeStringList(
	value: string | string[] | undefined,
): string[] | undefined {
	if (value === undefined) return undefined
	return Array.isArray(value) ? value : [value]
}

export const __test = {
	buildServerRouter,
	buildRouter,
	buildHandlers,
	describeServerTools,
	describeTool,
	addDiscoverOptions,
}

async function promptForServersToRemove(
	registry: RegistryView,
): Promise<string[]> {
	const names = Object.keys(registry.servers).sort()
	if (names.length === 0) {
		throw new Error('No MCP servers are registered. Nothing to remove.')
	}

	if (!process.stdin.isTTY) {
		throw new Error(
			'mcpx @remove requires --name when not running in an interactive terminal.',
		)
	}

	const result = await multiselect({
		message:
			'Select MCP server(s) to remove (space to toggle, enter to confirm)',
		options: names.map((name) => {
			const server = registry.servers[name]!
			const toolCount = server.tools?.length ?? 0
			const transport =
				server.transport === 'stdio' ? 'stdio' : `http (${server.auth.kind})`
			return {
				value: name,
				label: name,
				hint: `${transport} · ${toolCount} tool${toolCount === 1 ? '' : 's'}`,
			}
		}),
		required: true,
	})

	if (isCancel(result)) {
		cancel('Removal cancelled.')
		process.exit(1)
	}

	return result.map((name) => assertServerName(name))
}

function parseRemoveNames(value: string): string[] {
	const names = value
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
	if (names.length === 0) {
		throw new Error('Provide at least one server name to remove.')
	}
	const seen = new Set<string>()
	const result: string[] = []
	for (const name of names) {
		const normalized = assertServerName(name)
		if (seen.has(normalized)) continue
		seen.add(normalized)
		result.push(normalized)
	}
	return result
}
