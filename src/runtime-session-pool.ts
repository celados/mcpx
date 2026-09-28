import { createHash } from 'node:crypto'

import type { McpConnection } from './mcp-client'
import type { RuntimeCaller } from './runtime-caller'
import type { NotificationMode } from './runtime-protocol'
import type { DeclaredServer, RuntimeStores } from './runtime-stores'
import type { McpTool, ServerConfig, ToolDefinition } from './types'

import { normalizeAuthScheme } from './headers'
import {
	connectMcpClient,
	listAllMcpTools,
	toolCallRequestOptions,
} from './mcp-client'
import { assignCommandNames } from './names'
import {
	createNotificationBuffer,
	flushNotificationBuffer,
} from './notifications'
import { shouldRefreshOAuthToken } from './oauth'
import {
	progressEvent,
	reauthRequired,
	RuntimeAuthentication,
} from './runtime-authentication'
import {
	CancelableFifo,
	RuntimeCall,
	RuntimeOperationError,
} from './runtime-call'

type Connect = typeof connectMcpClient

type ResolvedServer = {
	key: string
	config: ServerConfig
}

type ManagedRuntimeSession = {
	key: string
	serverNames: Set<string>
	config: ServerConfig
	connection?: McpConnection
	connecting?: Promise<McpConnection>
	queue: CancelableFifo
	lastSessionId?: string
	currentBuffer?: ReturnType<typeof createNotificationBuffer>
	pendingToolsChanged: boolean
	lastUsedAt: number
	evictCount: number
	closing: boolean
}

export type RuntimeCallInput = {
	serverName: string
	toolName: string
	input: Record<string, unknown>
	notificationMode?: NotificationMode
}

export type RuntimeSessionStatus = {
	serverKey: string
	labels: string[]
	transport: 'stdio' | 'http'
	pid?: number | null
	url?: string
	activeCalls: number
	queuedCalls: number
	idleMs: number
	evictCount: number
	hasRetainedSessionId: boolean
}

export class RuntimeSessionPool {
	readonly #stores: RuntimeStores
	readonly #connect: Connect
	readonly #authentication: RuntimeAuthentication
	readonly #sessions = new Map<string, ManagedRuntimeSession>()
	readonly #bearerCursors = new Map<string, number>()
	#accepting = true

	constructor(
		stores: RuntimeStores,
		options: {
			connect?: Connect
			authentication?: RuntimeAuthentication
		} = {},
	) {
		this.#stores = stores
		this.#connect = options.connect ?? connectMcpClient
		this.#authentication =
			options.authentication ?? new RuntimeAuthentication(stores)
	}

	async call(call: RuntimeCall, input: RuntimeCallInput): Promise<void> {
		if (!this.#accepting) {
			throw new RuntimeOperationError('cancelled', 'MCP Runtime is stopping.')
		}
		const resolved = await this.#resolveServer(input.serverName)
		// Waiting for authorization happens before queueing so it neither consumes
		// the tool timeout nor blocks unrelated work queued on this session.
		if ((await this.#authorize(input.serverName, call)) === 'disconnected')
			return
		if (call.state === 'terminal') return
		this.#assertAccepting()
		const session = this.#sessionFor(input.serverName, resolved)
		session.queue.enqueue(call, (signal) =>
			this.#runAuthorized(session, input.serverName, call, signal, (headers) =>
				this.#callTool(session, call, input, headers, signal),
			),
		)
		await call.settled
	}

	async listTools(
		serverName: string,
		caller: RuntimeCaller,
	): Promise<Awaited<ReturnType<typeof listAllMcpTools>>> {
		this.#assertAccepting()
		const resolved = await this.#resolveServer(serverName)
		this.#assertAccepting()
		const session = this.#sessionFor(serverName, resolved)
		let tools: Awaited<ReturnType<typeof listAllMcpTools>> | undefined
		let failure: RuntimeOperationError | undefined
		const childCaller: RuntimeCaller = {
			id: `${caller.id}:schema:${serverName}`,
			onDisconnect: caller.onDisconnect,
			requestInput: caller.requestInput,
			send: async (frame) => {
				if (frame.kind === 'result') tools = frame.result as typeof tools
				else if (frame.kind === 'error')
					failure = new RuntimeOperationError(
						frame.error.code,
						frame.error.message,
					)
				else await caller.send({ ...frame, requestId: caller.id })
			},
		}
		const call = new RuntimeCall(childCaller)
		session.queue.enqueue(call, (signal) =>
			this.#runAuthorized(
				session,
				serverName,
				call,
				signal,
				async (headers) => {
					const timeout = setTimeout(() => {
						void call.cancel('timeout')
					}, toolCallRequestOptions().timeout)
					timeout.unref()
					try {
						return await listAllMcpTools(
							(await this.#ensureConnected(session, headers)).client,
						)
					} finally {
						clearTimeout(timeout)
						session.lastUsedAt = Date.now()
					}
				},
			),
		)
		await call.settled
		if (failure) throw failure
		if (!tools) {
			throw new RuntimeOperationError(
				call.cancellationCause === 'timeout' ? 'timeout' : 'cancelled',
				call.cancellationCause === 'timeout'
					? `Listing tools for ${serverName} timed out.`
					: `Listing tools for ${serverName} was cancelled.`,
			)
		}
		return tools
	}

	#authorize(
		serverName: string,
		call: RuntimeCall,
		rejected = false,
	): ReturnType<RuntimeAuthentication['authorize']> {
		return this.#authentication.authorize(serverName, call.caller, {
			rejected,
			signal: call.signal,
			onProgress: (progress) => call.emit(progressEvent(progress)),
		})
	}

	/**
	 * Runs one attempt with the current credential. A 401 means the server never
	 * executed the request, so it is safe to replace the credential and retry
	 * once.
	 */
	async #runAuthorized<T>(
		session: ManagedRuntimeSession,
		serverName: string,
		call: RuntimeCall,
		signal: AbortSignal,
		run: (headers: Record<string, string> | undefined) => Promise<T>,
	): Promise<T> {
		for (let retried = false; ; retried = true) {
			const headers = await this.#resolveHeaders(serverName)
			signal.throwIfAborted()
			if (session.closing) {
				throw new RuntimeOperationError(
					'cancelled',
					'MCP Runtime session is closing.',
				)
			}
			try {
				return await run(headers)
			} catch (error) {
				if (!isUnauthorizedError(error)) throw error
				session.evictCount += 1
				await this.#closeSession(session, false)
				if (retried) throw reauthRequired(serverName)
			}
			if ((await this.#authorize(serverName, call, true)) === 'disconnected')
				throw new RuntimeOperationError('cancelled', 'Runtime caller left.')
			signal.throwIfAborted()
		}
	}

	async #callTool(
		session: ManagedRuntimeSession,
		call: RuntimeCall,
		input: RuntimeCallInput,
		headers: Record<string, string> | undefined,
		signal: AbortSignal,
	) {
		const buffer = createNotificationBuffer()
		const requestOptions = toolCallRequestOptions()
		if (input.notificationMode !== 'discard') {
			requestOptions.onprogress = (progress) => {
				buffer.add({
					method: 'notifications/progress',
					params: { progressToken: call.id, ...progress },
				})
			}
		}
		const timeout = setTimeout(() => {
			void call.cancel('timeout')
		}, requestOptions.timeout)
		timeout.unref()
		session.currentBuffer =
			input.notificationMode === 'discard' ? undefined : buffer
		try {
			const connection = await this.#ensureConnected(session, headers)
			const result = await connection.client.callTool(
				{ name: input.toolName, arguments: input.input },
				undefined,
				{ ...requestOptions, signal },
			)
			const notifications = await flushNotificationBuffer(buffer)
			const toolsChanged = buffer.toolsChanged() || session.pendingToolsChanged
			session.pendingToolsChanged = false
			if (toolsChanged) {
				const tools = await listAllMcpTools(connection.client)
				await this.#stores.updateState((state) => {
					state.schemas.servers[input.serverName] = {
						tools: withCommandNames(tools),
						discoveredAt: new Date().toISOString(),
						refreshStatus: {
							checkedAt: new Date().toISOString(),
							status: 'ok',
						},
					}
				})
			}
			return { result, notifications, toolsChanged }
		} finally {
			clearTimeout(timeout)
			delete session.currentBuffer
			session.lastUsedAt = Date.now()
		}
	}

	status(): RuntimeSessionStatus[] {
		const now = Date.now()
		return [...this.#sessions.values()].map((session) => {
			const item: RuntimeSessionStatus = {
				serverKey: session.key,
				labels: [...session.serverNames].sort(),
				transport: session.config.transport === 'stdio' ? 'stdio' : 'http',
				...session.queue.status(),
				idleMs: now - session.lastUsedAt,
				evictCount: session.evictCount,
				hasRetainedSessionId: session.lastSessionId !== undefined,
			}
			if (session.config.transport === 'stdio') {
				item.pid = session.connection?.pid() ?? null
			} else {
				const url = new URL(session.config.url)
				item.url = `${url.host}${url.pathname}`
			}
			return item
		})
	}

	async cleanupIdle(maxIdleMs: number): Promise<void> {
		const cutoff = Date.now() - maxIdleMs
		const idle = [...this.#sessions.values()].filter((session) => {
			const status = session.queue.status()
			return (
				status.activeCalls === 0 &&
				status.queuedCalls === 0 &&
				session.lastUsedAt <= cutoff
			)
		})
		for (const session of idle) this.#sessions.delete(session.key)
		await Promise.all(
			idle.map((session) => this.#closeSession(session, false, true)),
		)
	}

	sessionCount(): number {
		return this.#sessions.size
	}

	async close(): Promise<void> {
		this.#accepting = false
		await Promise.all(
			[...this.#sessions.values()].map((session) =>
				session.queue.cancelAll('runtime-stopping'),
			),
		)
		const sessions = [...this.#sessions.values()]
		this.#sessions.clear()
		await Promise.all(
			sessions.map(async (session) => {
				await session.queue.idle()
				await this.#closeSession(session, false, true)
			}),
		)
	}

	async #resolveServer(serverName: string): Promise<ResolvedServer> {
		const { registry, credentials } = await this.#stores.readState()
		const declared = registry.servers[serverName]
		if (!declared) {
			throw new RuntimeOperationError(
				'operation-failed',
				`Unknown MCP server: ${serverName}.`,
			)
		}

		const key = stableServerKey(declared)
		if (declared.transport === 'stdio') {
			return {
				key: stableServerKey({ name: serverName, ...declared }),
				config: { ...declared, env: credentials.stdioEnv[serverName] },
			}
		}

		return { key, config: { url: declared.url, auth: { kind: 'none' } } }
	}

	async #resolveHeaders(
		serverName: string,
	): Promise<Record<string, string> | undefined> {
		const { registry, credentials } = await this.#stores.readState()
		const declared = registry.servers[serverName]
		if (!declared)
			throw new RuntimeOperationError(
				'operation-failed',
				`Unknown MCP server: ${serverName}.`,
			)
		if (declared.transport === 'stdio') return undefined

		const headers: Record<string, string> = {
			Accept: 'application/json, text/event-stream',
			...(credentials.headers[serverName] ?? {}),
		}
		if (declared.auth.kind === 'bearer') {
			const key = stableServerKey(declared)
			const cursor = this.#bearerCursors.get(key) ?? 0
			const credential =
				declared.auth.credentials[cursor % declared.auth.credentials.length]
			if (!credential) {
				throw reauthRequired(serverName)
			}
			this.#bearerCursors.set(
				key,
				(cursor + 1) % declared.auth.credentials.length,
			)
			const value =
				credential.kind === 'env'
					? process.env[credential.name]
					: credentials.bearer[credential.key]
			if (!value) throw reauthRequired(serverName)
			headers.Authorization = value.startsWith('Bearer ')
				? value
				: `Bearer ${value}`
		} else if (declared.auth.kind === 'oauth-token') {
			const token = credentials.oauth[declared.auth.tokenKey]
			// Authorization already ran before queueing; this only catches a credential
			// that expired or vanished while the Call waited for its turn.
			if (!token || shouldRefreshOAuthToken(token)) {
				throw reauthRequired(serverName)
			}
			headers.Authorization = `${normalizeAuthScheme(token.tokenType)} ${token.accessToken}`
		} else if (
			declared.auth.kind === 'oauth' ||
			declared.auth.kind === 'unknown'
		) {
			throw reauthRequired(serverName)
		}

		return headers
	}

	#sessionFor(
		serverName: string,
		resolved: ResolvedServer,
	): ManagedRuntimeSession {
		const existing = this.#sessions.get(resolved.key)
		if (existing) {
			existing.serverNames.add(serverName)
			return existing
		}

		const session: ManagedRuntimeSession = {
			key: resolved.key,
			serverNames: new Set([serverName]),
			config: resolved.config,
			queue: new CancelableFifo(),
			pendingToolsChanged: false,
			lastUsedAt: Date.now(),
			evictCount: 0,
			closing: false,
		}
		this.#sessions.set(resolved.key, session)
		return session
	}

	async #ensureConnected(
		session: ManagedRuntimeSession,
		headers?: Record<string, string>,
	): Promise<McpConnection> {
		if (session.closing) {
			throw new RuntimeOperationError(
				'cancelled',
				'MCP Runtime session is closing.',
			)
		}
		if (session.connection) {
			if (headers) session.connection.updateHeaders(headers)
			return session.connection
		}
		if (!session.connecting) {
			session.connecting = this.#connect(session.config, {
				headers,
				sessionId: session.lastSessionId,
				onNotification: (notification) => {
					if (session.currentBuffer) {
						session.currentBuffer.add(notification)
					} else if (
						notification.method === 'notifications/tools/list_changed'
					) {
						session.pendingToolsChanged = true
					}
				},
			})
				.then(async (connection) => {
					if (session.closing) {
						await connection.close().catch(() => {})
						throw new RuntimeOperationError(
							'cancelled',
							'MCP Runtime session closed while connecting.',
						)
					}
					session.connection = connection
					return connection
				})
				.finally(() => {
					delete session.connecting
				})
		}
		return session.connecting
	}

	async #closeSession(
		session: ManagedRuntimeSession,
		retainSessionId: boolean,
		retire = false,
	): Promise<void> {
		session.closing = true
		if (retainSessionId && session.config.transport !== 'stdio') {
			session.lastSessionId =
				session.connection?.sessionId() ?? session.lastSessionId
		}
		const connection =
			session.connection ?? (await session.connecting?.catch(() => undefined))
		await connection?.close().catch(() => {})
		delete session.connection
		delete session.connecting
		if (!retainSessionId) delete session.lastSessionId
		if (!retire) session.closing = false
	}

	#assertAccepting(): void {
		if (!this.#accepting) {
			throw new RuntimeOperationError('cancelled', 'MCP Runtime is stopping.')
		}
	}
}

function stableServerKey(server: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(sortValue(server)))
		.digest('hex')
		.slice(0, 16)
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue)
	if (!value || typeof value !== 'object') return value
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, sortValue(item)]),
	)
}

function isUnauthorizedError(error: unknown): boolean {
	if (error instanceof RuntimeOperationError) return false
	if (error instanceof Error) {
		const code = (error as { code?: unknown }).code
		if (code === 401 || error.name === 'UnauthorizedError') return true
	}
	const message = error instanceof Error ? error.message : String(error)
	return /\b401\b/.test(message) || /unauthorized/i.test(message)
}

function withCommandNames(tools: McpTool[]): ToolDefinition[] {
	const names = assignCommandNames(tools.map((tool) => tool.name))
	return tools.map((tool) => {
		const normalized: ToolDefinition = {
			name: tool.name,
			commandName: names.get(tool.name) ?? tool.name,
		}
		if (tool.title) normalized.title = tool.title
		if (tool.description) normalized.description = tool.description
		if (
			tool.inputSchema &&
			typeof tool.inputSchema === 'object' &&
			!Array.isArray(tool.inputSchema)
		) {
			normalized.inputSchema = tool.inputSchema as Record<string, unknown>
		}
		if (tool.annotations) normalized.annotations = tool.annotations
		if (tool._meta) normalized._meta = tool._meta
		return normalized
	})
}
