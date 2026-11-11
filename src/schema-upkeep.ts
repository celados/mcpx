import type { RuntimeCaller } from './runtime-caller'
import type { RuntimeSessionPool, SchemaSignal } from './runtime-session-pool'
import type { RuntimeStores } from './runtime-stores'

import { normalizeTools } from './discovery'
import { RuntimeOperationError } from './runtime-call'

/** A schema listed more recently than this is not re-listed on reconnect. */
const CONNECTED_FRESH_MS = 60 * 60 * 1000
/** A rejection re-lists at most this often, so a broken call cannot loop. */
const REJECTED_FRESH_MS = 60 * 1000
/** The sweep re-lists every server whose schema is older than this. */
export const SWEEP_STALE_MS = 7 * 24 * 60 * 60 * 1000
const SWEEP_CONCURRENCY = 2

/**
 * Keeps the Schema Cache close to what servers actually expose, in the
 * background, without ever opening a browser (ADR 0011). The cache is a hint
 * for agents; servers stay the authority on what a call accepts.
 *
 * - A session (re)connect re-lists a schema older than an hour;
 * - An Invalid Params rejection re-lists right away;
 * - A sweep re-lists every schema older than a week.
 *
 * One mcpxd per user and one in-flight listing per server make the upkeep
 * exclusive: concurrent hints for a server share its listing.
 */
export class SchemaUpkeep {
	readonly #stores: RuntimeStores
	readonly #sessions: () => RuntimeSessionPool
	readonly #inFlight = new Map<string, Promise<void>>()
	readonly #hints = new Set<Promise<void>>()
	#sweeping: Promise<void> | undefined
	#closed = false

	constructor(stores: RuntimeStores, sessions: () => RuntimeSessionPool) {
		this.#stores = stores
		this.#sessions = sessions
	}

	/** The session pool's hint that a server's schema may be stale. */
	readonly signal = (signal: SchemaSignal): void => {
		const hint = this.#relistIfOlderThan(
			signal.serverName,
			signal.reason === 'connected' ? CONNECTED_FRESH_MS : REJECTED_FRESH_MS,
		)
			.catch(() => {})
			.finally(() => {
				this.#hints.delete(hint)
			})
		this.#hints.add(hint)
	}

	/** Re-lists every server whose schema is older than `staleMs`. Exclusive. */
	sweep(staleMs: number = SWEEP_STALE_MS): Promise<void> {
		this.#sweeping ??= this.#sweep(staleMs).finally(() => {
			this.#sweeping = undefined
		})
		return this.#sweeping
	}

	/** Resolves once every listing started so far has settled. */
	async idle(): Promise<void> {
		while (this.#hints.size > 0 || this.#inFlight.size > 0 || this.#sweeping)
			await Promise.all([
				this.#sweeping,
				...this.#hints,
				...this.#inFlight.values(),
			])
	}

	close(): void {
		this.#closed = true
	}

	async #sweep(staleMs: number): Promise<void> {
		const { registry, schemas } = await this.#stores.readState()
		const now = Date.now()
		const stale = Object.keys(registry.servers)
			.sort()
			.filter(
				(name) =>
					now - listedAt(schemas.servers[name]?.discoveredAt) >= staleMs,
			)
		let next = 0
		await Promise.all(
			Array.from(
				{ length: Math.min(SWEEP_CONCURRENCY, stale.length) },
				async () => {
					while (next < stale.length && !this.#closed)
						await this.#relist(stale[next++] as string)
				},
			),
		)
	}

	async #relistIfOlderThan(serverName: string, freshMs: number): Promise<void> {
		if (this.#closed || this.#inFlight.has(serverName)) return
		const cached = (await this.#stores.schemas.read()).servers[serverName]
		const lastTry = Math.max(
			listedAt(cached?.discoveredAt),
			listedAt(cached?.refreshStatus?.checkedAt),
		)
		if (Date.now() - lastTry < freshMs) return
		await this.#relist(serverName)
	}

	#relist(serverName: string): Promise<void> {
		const running = this.#inFlight.get(serverName)
		if (running) return running
		const run = this.#list(serverName).finally(() => {
			this.#inFlight.delete(serverName)
		})
		this.#inFlight.set(serverName, run)
		return run
	}

	async #list(serverName: string): Promise<void> {
		if (this.#closed) return
		const checkedAt = new Date().toISOString()
		try {
			const tools = await this.#sessions().listTools(
				serverName,
				backgroundCaller(serverName),
				{ interactive: false },
			)
			await this.#stores.updateState((state) => {
				if (!state.registry.servers[serverName]) return
				state.schemas.servers[serverName] = {
					tools: normalizeTools(tools),
					discoveredAt: checkedAt,
					refreshStatus: { checkedAt, status: 'ok' },
				}
			})
		} catch (error) {
			// Keep the last good tools; record why this check failed. A credential
			// the next real call can repair is not upkeep's to fix.
			const failure =
				error instanceof RuntimeOperationError
					? error
					: new RuntimeOperationError(
							'operation-failed',
							error instanceof Error ? error.message : String(error),
						)
			if (failure.code === 'cancelled') return
			await this.#stores
				.updateState((state) => {
					if (!state.registry.servers[serverName]) return
					state.schemas.servers[serverName] = {
						...state.schemas.servers[serverName],
						refreshStatus: {
							checkedAt,
							status:
								failure.code === 'reauth-required'
									? 'reauth-required'
									: 'unreachable',
							message: failure.message,
						},
					}
				})
				.catch(() => {})
		}
	}
}

function listedAt(value: string | undefined): number {
	const time = value ? Date.parse(value) : Number.NaN
	return Number.isFinite(time) ? time : 0
}

/** Nobody waits on upkeep: no input, no disconnect, frames are dropped. */
function backgroundCaller(serverName: string): RuntimeCaller {
	return {
		id: `upkeep:${serverName}:${crypto.randomUUID()}`,
		onDisconnect: () => () => {},
		requestInput: async () => {
			throw new RuntimeOperationError(
				'reauth-required',
				'Background schema upkeep cannot ask for input.',
			)
		},
		send: async () => {},
	}
}
