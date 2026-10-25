import type { AuthProvider, RequestOptions } from '@modelcontextprotocol/client'
import type { Stream } from 'node:stream'

import {
	Client,
	extractWWWAuthenticateParams,
	InsufficientScopeError,
	SdkHttpError,
	StreamableHTTPClientTransport,
	UnauthorizedError,
} from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

import type { OAuthChallenge } from './oauth'
import type { McpTool, ServerConfig, ToolAnnotations } from './types'

import { resolveHeaders } from './headers'
import { MCPX_VERSION } from './version'

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000
const TOOL_CALL_TIMEOUT_ENV = 'MCPX_TOOL_CALL_TIMEOUT_MS'

type ListToolsClient = {
	listTools: (params?: { cursor?: string }) => Promise<{
		tools?: RawMcpTool[] | undefined
		nextCursor?: string | undefined
	}>
}

type RawMcpTool = {
	name: string
	title?: unknown
	description?: unknown
	inputSchema?: unknown
	annotations?: unknown
	_meta?: unknown
}

export type McpConnection = {
	client: Client
	close: () => Promise<void>
	pid: () => number | null
	stderr: Stream | null
	sessionId: () => string | undefined
	updateHeaders: (headers: Record<string, string>) => void
	/** The bearer token sent with every later request; `undefined` sends none. */
	updateToken: (token: string | undefined) => void
}

export type ConnectMcpClientOptions = {
	headers?: Record<string, string> | undefined
	token?: string | undefined
	sessionId?: string | undefined
	onNotification?: (notification: { method: string; params?: unknown }) => void
}

export async function withMcpClient<T>(
	server: ServerConfig,
	run: (client: Client) => Promise<T>,
): Promise<T> {
	const session = await connectMcpClient(server)

	try {
		return await run(session.client)
	} finally {
		await session.close()
	}
}

export async function connectMcpClient(
	server: ServerConfig,
	options: ConnectMcpClientOptions = {},
): Promise<McpConnection> {
	const client = new Client({ name: 'mcpx', version: MCPX_VERSION })
	if (options.onNotification) {
		client.fallbackNotificationHandler = async (notification) => {
			options.onNotification?.(notification)
		}
	}
	const httpHeaders =
		server.transport === 'stdio'
			? undefined
			: (options.headers ?? (await resolveHeaders(server)))
	let token = options.token
	const transport =
		server.transport === 'stdio'
			? new StdioClientTransport(stdioTransportParams(server))
			: new StreamableHTTPClientTransport(
					new URL(server.url),
					httpTransportOptions(httpHeaders, options, () => token),
				)

	await client.connect(transport as never)
	return {
		client,
		close: async () => {
			await client.close().catch(() => {})
			await transport.close().catch(() => {})
		},
		pid: () =>
			server.transport === 'stdio' && transport instanceof StdioClientTransport
				? transport.pid
				: null,
		stderr:
			server.transport === 'stdio' && transport instanceof StdioClientTransport
				? transport.stderr
				: null,
		sessionId: () =>
			transport instanceof StreamableHTTPClientTransport
				? transport.sessionId
				: undefined,
		updateHeaders: (headers) => {
			if (!httpHeaders) return
			for (const key of Object.keys(httpHeaders)) delete httpHeaders[key]
			Object.assign(httpHeaders, headers)
		},
		updateToken: (next) => {
			token = next
		},
	}
}

/**
 * Rejection of a request by the resource server's auth layer. The Runtime, not
 * the transport, owns what happens next: the challenge is the discovery entry
 * for OAuth at any time, not only when a server is added.
 */
export class AuthorizationChallengeError extends Error {
	readonly challenge: OAuthChallenge

	constructor(challenge: OAuthChallenge) {
		super(
			challenge.status === 401
				? 'Unauthorized'
				: `Insufficient scope${challenge.scope ? `: required "${challenge.scope}"` : ''}`,
		)
		this.name = 'AuthorizationChallengeError'
		this.challenge = challenge
	}
}

export function authorizationChallenge(
	error: unknown,
): OAuthChallenge | undefined {
	if (error instanceof AuthorizationChallengeError) return error.challenge
	if (error instanceof InsufficientScopeError) {
		const challenge: OAuthChallenge = { status: 403 }
		if (error.requiredScope) challenge.scope = error.requiredScope
		if (error.resourceMetadataUrl)
			challenge.resourceMetadataUrl = error.resourceMetadataUrl.toString()
		return challenge
	}
	if (error instanceof UnauthorizedError) return { status: 401 }
	if (error instanceof SdkHttpError && error.status === 401)
		return { status: 401 }
	return undefined
}

// The transport asks for the token before every request and reports a 401
// here instead of running the SDK's own OAuth flow inside the request.
function challengeAuthProvider(token: () => string | undefined): AuthProvider {
	return {
		token: async () => token(),
		onUnauthorized: async ({ response }) => {
			const { resourceMetadataUrl, scope } =
				extractWWWAuthenticateParams(response)
			const challenge: OAuthChallenge = { status: 401 }
			if (resourceMetadataUrl)
				challenge.resourceMetadataUrl = resourceMetadataUrl.toString()
			if (scope) challenge.scope = scope
			throw new AuthorizationChallengeError(challenge)
		},
	}
}

function httpTransportOptions(
	headers: Record<string, string> | undefined,
	options: ConnectMcpClientOptions,
	token: () => string | undefined,
): ConstructorParameters<typeof StreamableHTTPClientTransport>[1] {
	const transportOptions: NonNullable<
		ConstructorParameters<typeof StreamableHTTPClientTransport>[1]
	> = {
		authProvider: challengeAuthProvider(token),
		// A 403 step-up is an Authentication Flow the Runtime coordinates.
		onInsufficientScope: 'throw',
	}
	if (headers) transportOptions.requestInit = { headers }
	if (options.sessionId) transportOptions.sessionId = options.sessionId
	return transportOptions
}

function stdioTransportParams(server: ServerConfig) {
	if (server.transport !== 'stdio')
		throw new Error('Expected stdio MCP server config.')

	const params: ConstructorParameters<typeof StdioClientTransport>[0] = {
		command: server.command,
		stderr: 'pipe',
	}
	if (server.args) params.args = server.args
	if (server.env) params.env = server.env
	if (server.cwd) params.cwd = server.cwd
	return params
}

export async function listMcpTools(
	server: ServerConfig,
	_serverName = 'stdio',
): Promise<McpTool[]> {
	return withMcpClient(server, async (client) => listAllMcpTools(client))
}

export async function listAllMcpTools(
	client: ListToolsClient,
): Promise<McpTool[]> {
	const tools: McpTool[] = []
	let cursor: string | undefined

	do {
		const response = await client.listTools(cursor ? { cursor } : undefined)
		tools.push(...(response.tools ?? []).map(normalizeMcpTool))
		cursor = response.nextCursor
	} while (cursor)

	return tools
}

export function normalizeMcpTool(tool: RawMcpTool): McpTool {
	const normalized: McpTool = { name: tool.name }
	if (typeof tool.title === 'string') normalized.title = tool.title
	if (typeof tool.description === 'string')
		normalized.description = tool.description
	if (tool.inputSchema) normalized.inputSchema = tool.inputSchema
	if (isToolAnnotations(tool.annotations))
		normalized.annotations = tool.annotations
	if (isRecord(tool._meta)) normalized._meta = tool._meta
	return normalized
}

export async function callMcpTool(
	server: ServerConfig,
	toolName: string,
	input: Record<string, unknown>,
	_serverName = 'stdio',
): Promise<unknown> {
	return withMcpClient(server, async (client) =>
		client.callTool(
			{ name: toolName, arguments: input },
			toolCallRequestOptions(),
		),
	)
}

export function toolCallRequestOptions(): RequestOptions {
	return { timeout: toolCallTimeoutMs() }
}

function toolCallTimeoutMs(): number {
	const raw = process.env[TOOL_CALL_TIMEOUT_ENV]
	if (!raw) return DEFAULT_TOOL_CALL_TIMEOUT_MS

	const parsed = Number(raw)
	if (Number.isFinite(parsed) && parsed > 0) return parsed
	return DEFAULT_TOOL_CALL_TIMEOUT_MS
}

function isToolAnnotations(value: unknown): value is ToolAnnotations {
	return isRecord(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}
