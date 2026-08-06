import type { RuntimeCaller } from './runtime-caller'
import type { RuntimeIntent } from './runtime-protocol'
import type { RuntimeStores } from './runtime-stores'

import { discoverServer, normalizeTools } from './discovery'
import { RuntimeAuthentication } from './runtime-authentication'
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
		this.#sessions = options.sessions ?? new RuntimeSessionPool(stores)
		this.#authentication =
			options.authentication ?? new RuntimeAuthentication(stores)
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
					const outcome = await this.#authentication.refreshServers(
						intent.serverNames,
						caller,
					)
					if (outcome.status === 'disconnected') return
					const snapshot = await this.#stores.readSnapshot()
					const names =
						intent.serverNames ?? Object.keys(snapshot.servers).sort()
					for (const name of names) {
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
					}
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

function runtimeError(error: unknown): {
	code: 'operation-failed' | 'reauth-required'
	message: string
} {
	if (error instanceof RuntimeOperationError) {
		return {
			code:
				error.code === 'reauth-required'
					? 'reauth-required'
					: 'operation-failed',
			message: error.message,
		}
	}
	return {
		code: 'operation-failed',
		message: error instanceof Error ? error.message : String(error),
	}
}
