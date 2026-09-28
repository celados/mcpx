import type { RuntimeCaller } from './runtime-caller'

import { RuntimeOperationError } from './runtime-call'

export type AuthenticationProgress = {
	phase: 'refreshing-token' | 'awaiting-input' | 'awaiting-browser'
	message: string
	url?: string
}

export type AuthenticationFlow<T> = {
	start: (
		signal: AbortSignal,
		requestInput: RuntimeCaller['requestInput'],
		report: (progress: AuthenticationProgress) => void,
	) => Promise<T>
	persist: (value: T) => Promise<void>
}

export type AuthenticationWaiterOutcome =
	| { status: 'completed' }
	| { status: 'disconnected' }

type Waiter = {
	caller: RuntimeCaller
	unsubscribe: () => void
	onProgress?: ((progress: AuthenticationProgress) => void) | undefined
	resolve: (outcome: AuthenticationWaiterOutcome) => void
	reject: (error: Error) => void
}

type ActiveFlow<T> = {
	controller: AbortController
	waiters: Map<string, Waiter>
	timer: Timer
	finished: boolean
	flow: AuthenticationFlow<T>
	progress?: AuthenticationProgress
	run?: Promise<void>
}

const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60 * 1000

export class AuthenticationCoordinator {
	readonly #timeoutMs: number
	readonly #flows = new Map<string, ActiveFlow<unknown>>()
	readonly #running = new Set<ActiveFlow<unknown>>()
	#accepting = true

	constructor(options: { timeoutMs?: number } = {}) {
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS
	}

	join<T>(
		identity: string,
		caller: RuntimeCaller,
		flow: AuthenticationFlow<T>,
		onProgress?: (progress: AuthenticationProgress) => void,
	): Promise<AuthenticationWaiterOutcome> {
		if (!this.#accepting) {
			return Promise.reject(
				new RuntimeOperationError('cancelled', 'MCP Runtime is stopping.'),
			)
		}
		let entry = this.#flows.get(identity) as ActiveFlow<T> | undefined
		let created = false
		if (!entry) {
			entry = this.#createFlow(identity, flow)
			this.#flows.set(identity, entry as ActiveFlow<unknown>)
			this.#running.add(entry as ActiveFlow<unknown>)
			created = true
		}

		const waiterPromise = new Promise<AuthenticationWaiterOutcome>(
			(resolve, reject) => {
				const waiter: Waiter = {
					caller,
					onProgress,
					resolve,
					reject,
					unsubscribe: () => {},
				}
				entry.waiters.set(caller.id, waiter)
				// Late joiners still need the authorization URL an earlier waiter saw.
				if (entry.progress) notifyProgress(waiter, entry.progress)
				const unsubscribe = caller.onDisconnect(() => {
					this.#removeWaiter(identity, entry, waiter)
				})
				waiter.unsubscribe = unsubscribe
				if (!entry.waiters.has(caller.id)) unsubscribe()
			},
		)
		// Register the first waiter before starting code that may throw synchronously.
		if (created) entry.run = this.#runFlow(identity, entry)
		return waiterPromise
	}

	activeFlows(): number {
		return this.#running.size
	}

	async close(): Promise<void> {
		this.#accepting = false
		const entries = [...this.#running]
		for (const entry of entries) {
			entry.controller.abort(
				new AuthenticationCancelled('MCP Runtime is stopping.'),
			)
		}
		await Promise.all(entries.map((entry) => entry.run).filter(Boolean))
	}

	#createFlow<T>(identity: string, flow: AuthenticationFlow<T>): ActiveFlow<T> {
		const controller = new AbortController()
		const timer = setTimeout(() => {
			controller.abort(
				new AuthenticationTimeout(`Authentication Flow ${identity} timed out.`),
			)
		}, this.#timeoutMs)
		timer.unref()
		return {
			controller,
			waiters: new Map(),
			timer,
			finished: false,
			flow,
		}
	}

	async #runFlow<T>(identity: string, entry: ActiveFlow<T>): Promise<void> {
		let failure: Error | undefined
		try {
			const value = await entry.flow.start(
				entry.controller.signal,
				(request) => this.#requestInput(entry, request),
				(progress) => {
					if (entry.finished) return
					entry.progress = progress
					for (const waiter of entry.waiters.values())
						notifyProgress(waiter, progress)
				},
			)
			await entry.flow.persist(value)
		} catch (error) {
			failure = authenticationError(error)
		} finally {
			entry.finished = true
			this.#running.delete(entry as ActiveFlow<unknown>)
			clearTimeout(entry.timer)
			if (this.#flows.get(identity) === entry) this.#flows.delete(identity)
		}

		const waiters = [...entry.waiters.values()]
		entry.waiters.clear()
		for (const waiter of waiters) {
			waiter.unsubscribe()
			if (failure) waiter.reject(failure)
			else waiter.resolve({ status: 'completed' })
		}
	}

	async #requestInput<T>(
		entry: ActiveFlow<T>,
		request: Parameters<RuntimeCaller['requestInput']>[0],
	): Promise<unknown> {
		while (!entry.controller.signal.aborted) {
			const waiter = entry.waiters.values().next().value as Waiter | undefined
			if (!waiter)
				throw new AuthenticationCancelled(
					'Authentication Flow has no caller for interactive input.',
				)
			try {
				return await waiter.caller.requestInput(
					request,
					entry.controller.signal,
				)
			} catch (error) {
				// A surviving waiter can take over interaction from a disconnected caller.
				if (entry.waiters.has(waiter.caller.id)) throw error
			}
		}
		throw new AuthenticationCancelled('Authentication Flow was cancelled.')
	}

	#removeWaiter<T>(
		identity: string,
		entry: ActiveFlow<T>,
		waiter: Waiter,
	): void {
		if (!entry.waiters.delete(waiter.caller.id)) return
		waiter.unsubscribe()
		waiter.resolve({ status: 'disconnected' })
		if (entry.waiters.size === 0 && !entry.finished) {
			if (this.#flows.get(identity) === entry) this.#flows.delete(identity)
			entry.controller.abort(
				new AuthenticationCancelled(
					'Authentication Flow lost its final caller.',
				),
			)
		}
	}
}

function notifyProgress(
	waiter: Waiter,
	progress: AuthenticationProgress,
): void {
	try {
		waiter.onProgress?.(progress)
	} catch {
		// Progress is advisory; a failing renderer must not fail the shared flow.
	}
}

class AuthenticationTimeout extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AuthenticationTimeout'
	}
}

class AuthenticationCancelled extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AuthenticationCancelled'
	}
}

function authenticationError(error: unknown): Error {
	if (error instanceof AuthenticationTimeout) {
		return new RuntimeOperationError('timeout', error.message)
	}
	if (error instanceof AuthenticationCancelled) {
		return new RuntimeOperationError('cancelled', error.message)
	}
	if (error instanceof RuntimeOperationError) return error
	return new RuntimeOperationError(
		'operation-failed',
		error instanceof Error ? error.message : String(error),
	)
}
