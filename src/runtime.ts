import type { RuntimeCaller } from './runtime-caller'
import type { RuntimeError, RuntimeIntent } from './runtime-protocol'
import type { RuntimeStores } from './runtime-stores'

import { discoverServer, normalizeTools } from './discovery'
import { progressEvent, RuntimeAuthentication } from './runtime-authentication'
import { RuntimeCall, RuntimeOperationError } from './runtime-call'
import { DAEMON_PROTOCOL_VERSION } from './runtime-protocol'
import { RuntimeSessionPool } from './runtime-session-pool'
import { MCPX_VERSION } from './version'

export class McpRuntime {
	readonly #stores: RuntimeStores
	readonly #sessions: RuntimeSessionPool
	readonly #authentication: RuntimeAuthentication

	constructor(
		stores: RuntimeStores,
		options: {
			sessions?: RuntimeSessionPool
			authentication?: RuntimeAuthentication
		} = {},
	) {
		this.#stores = stores
		this.#authentication =
			options.authentication ?? new RuntimeAuthentication(stores)
		this.#sessions =
			options.sessions ??
			new RuntimeSessionPool(stores, { authentication: this.#authentication })
	}

	async cleanupIdleSessions(maxIdleMs: number): Promise<void> {
		await this.#sessions.cleanupIdle(maxIdleMs)
	}

	activeSessionCount(): number {
		return this.#sessions.sessionCount()
	}

	activeAuthenticationFlows(): number {
		return this.#authentication.activeFlows()
	}

	async handle(intent: RuntimeIntent, caller: RuntimeCaller): Promise<void> {
		switch (intent.op) {
			case 'registrySnapshot':
				await caller.send({
					requestId: intent.requestId,
					kind: 'result',
					result: await this.#stores.readSnapshot(),
				})
				return
			case 'call': {
				const call = new RuntimeCall(caller)
				try {
					await this.#sessions.call(call, intent)
				} catch (error) {
					await call.fail(runtimeError(error))
				}
				return
			}
			case 'status': {
				const sessions = this.#sessions.status()
				await caller.send({
					requestId: intent.requestId,
					kind: 'result',
					result: {
						pid: process.pid,
						protocolVersion: DAEMON_PROTOCOL_VERSION,
						version: MCPX_VERSION,
						activeServers: sessions.length,
						servers: sessions,
					},
				})
				return
			}
			case 'stop':
				await Promise.all([
					this.#sessions.close(),
					this.#authentication.close(),
				])
				await caller.send({
					requestId: intent.requestId,
					kind: 'result',
					result: { stopping: true },
				})
				return
			case 'refreshServers':
				try {
					const outcome = await this.#refreshServers(intent.serverNames, caller)
					if (outcome.status === 'disconnected') return
					await caller.send({
						requestId: intent.requestId,
						kind: 'result',
						result: outcome,
					})
				} catch (error) {
					await caller.send({
						requestId: intent.requestId,
						kind: 'error',
						error: runtimeError(error),
					})
				}
				return
			case 'addServer': {
				try {
					const result = await discoverServer(discoveryOptions(intent))
					await this.#stores.upsertServer(intent.serverName, result.server)
					await caller.send({
						requestId: intent.requestId,
						kind: 'result',
						result: {
							name: intent.serverName,
							transport: result.server.transport ?? 'http',
							status: result.status,
							auth:
								result.server.transport === 'stdio'
									? undefined
									: result.server.auth,
							tools: result.server.tools?.length ?? 0,
							message: result.message,
						},
					})
				} catch (error) {
					await caller.send({
						requestId: intent.requestId,
						kind: 'error',
						error: runtimeError(error),
					})
				}
				return
			}
			case 'removeServers': {
				const snapshot = await this.#stores.readSnapshot()
				const missing = intent.serverNames.filter(
					(name) => !snapshot.servers[name],
				)
				if (missing.length > 0) {
					await caller.send({
						requestId: intent.requestId,
						kind: 'error',
						error: {
							code: 'operation-failed',
							message: `Unknown MCP server(s): ${missing.join(', ')}.`,
						},
					})
					return
				}
				const removed = await this.#stores.removeServers(intent.serverNames)
				await caller.send({
					requestId: intent.requestId,
					kind: 'result',
					result:
						removed.length === 1
							? { ...removed[0], removed: true }
							: {
									removed: removed.map((item) => ({
										...item,
										removed: true,
									})),
								},
				})
			}
		}
	}
	async #refreshServers(
		serverNames: string[] | undefined,
		caller: RuntimeCaller,
	): Promise<RuntimeRefreshOutcome> {
		const registry = await this.#stores.registry.read()
		const names = serverNames ?? Object.keys(registry.servers).sort()
		const missing = names.filter((name) => !registry.servers[name])
		if (missing.length > 0) {
			throw new RuntimeOperationError(
				'operation-failed',
				`Unknown MCP server(s): ${missing.join(', ')}.`,
			)
		}

		let disconnected = false
		let stopped = false
		const unsubscribe = caller.onDisconnect(() => {
			disconnected = true
		})
		const report = (
			serverName: string,
			phase: string,
			message: string,
			url?: string,
		) => {
			if (disconnected) return
			const progress: Parameters<typeof progressEvent>[0] = {
				serverName,
				phase,
				message,
			}
			if (url) progress.url = url
			void caller
				.send({
					requestId: caller.id,
					kind: 'event',
					event: progressEvent(progress),
				})
				.catch(() => {})
		}
		const refreshed = new Set<string>()
		const failed = new Map<string, RuntimeRefreshFailure>()

		try {
			await forEachConcurrent(names, REFRESH_CONCURRENCY, async (name) => {
				if (disconnected || stopped) return
				try {
					report(name, 'checking', 'checking credentials')
					const authorized = await this.#authentication.authorize(
						name,
						caller,
						{
							onProgress: (progress) =>
								report(name, progress.phase, progress.message, progress.url),
						},
					)
					if (authorized === 'disconnected') return
					report(name, 'listing-tools', 'listing tools')
					const tools = await this.#sessions.listTools(name, caller)
					await this.#stores.updateState((state) => {
						state.schemas.servers[name] = {
							tools: normalizeTools(tools),
							discoveredAt: new Date().toISOString(),
							refreshStatus: {
								checkedAt: new Date().toISOString(),
								status: 'ok',
							},
						}
					})
					refreshed.add(name)
					report(
						name,
						'ok',
						`ok (${tools.length} tool${tools.length === 1 ? '' : 's'})`,
					)
				} catch (error) {
					if (disconnected || stopped) return
					const failure = runtimeError(error)
					// Cancellation (Runtime stop, declined prompt) ends the whole operation;
					// provider failures only mark their own server.
					if (failure.code === 'cancelled') {
						stopped = true
						throw error
					}
					failed.set(name, {
						serverName: name,
						message: failure.message,
					})
					await this.#stores
						.updateState((state) => {
							const current = state.schemas.servers[name]
							state.schemas.servers[name] = {
								...current,
								refreshStatus: {
									checkedAt: new Date().toISOString(),
									status:
										failure.code === 'reauth-required'
											? 'reauth-required'
											: 'unreachable',
									message: failure.message,
								},
							}
						})
						.catch(() => {})
					report(name, 'failed', failure.message)
				}
			})
		} finally {
			unsubscribe()
		}

		if (disconnected) return { status: 'disconnected' }
		return {
			status: 'completed',
			refreshed: names.filter((name) => refreshed.has(name)),
			failed: names.flatMap((name) => {
				const failure = failed.get(name)
				return failure ? [failure] : []
			}),
		}
	}
}

export type RuntimeRefreshOutcome =
	| {
			status: 'completed'
			refreshed: string[]
			failed: RuntimeRefreshFailure[]
	  }
	| { status: 'disconnected' }

export type RuntimeRefreshFailure = {
	serverName: string
	message: string
}

// Servers are independent; a bounded fan-out keeps one slow browser flow from
// holding every other server hostage without opening a page per server at once.
const REFRESH_CONCURRENCY = 4

async function forEachConcurrent<T>(
	items: T[],
	limit: number,
	run: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const item = items[next++] as T
				await run(item)
			}
		}),
	)
}

function discoveryOptions(intent: Extract<RuntimeIntent, { op: 'addServer' }>) {
	if (intent.transport === 'stdio') {
		if (!intent.command) throw new Error('Stdio MCP servers require a command.')
		return {
			name: intent.serverName,
			transport: 'stdio' as const,
			command: intent.command,
			args: intent.args,
			env: intent.env,
		}
	}
	if (!intent.url) throw new Error('HTTP MCP servers require a URL.')
	return {
		name: intent.serverName,
		transport: 'http' as const,
		url: intent.url,
		bearer: intent.bearer,
	}
}

function runtimeError(error: unknown): RuntimeError {
	if (error instanceof RuntimeOperationError) {
		return { code: error.code, message: error.message }
	}
	return {
		code: 'operation-failed',
		message: error instanceof Error ? error.message : String(error),
	}
}
