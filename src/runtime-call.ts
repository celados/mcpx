import type { RuntimeCaller } from './runtime-caller'
import type { RuntimeError, RuntimeFrame } from './runtime-protocol'

export type RuntimeCallState = 'accepted' | 'queued' | 'active' | 'terminal'
export type CallCancellationCause =
	| 'caller-disconnected'
	| 'runtime-stopping'
	| 'timeout'

export class RuntimeOperationError extends Error {
	readonly code: RuntimeError['code']

	constructor(code: RuntimeError['code'], message: string) {
		super(message)
		this.name = 'RuntimeOperationError'
		this.code = code
	}
}

type Executor = (signal: AbortSignal) => Promise<unknown>
type QueueEntry = {
	call: RuntimeCall
	execute: Executor
	unsubscribeTerminal: () => void
}

export class RuntimeCall {
	readonly #caller: RuntimeCaller
	readonly #controller = new AbortController()
	readonly #terminalListeners = new Set<() => void>()
	#state: RuntimeCallState = 'accepted'
	#cancellationCause: CallCancellationCause | undefined
	#callerConnected = true
	#unsubscribeDisconnect: () => void = () => {}
	readonly #settledPromise: Promise<void>
	#resolveSettled = () => {}

	constructor(caller: RuntimeCaller) {
		this.#caller = caller
		this.#settledPromise = new Promise((resolve) => {
			this.#resolveSettled = resolve
		})
		const unsubscribe = caller.onDisconnect(() => {
			this.#callerConnected = false
			void this.#finish({ cause: 'caller-disconnected', abort: true })
		})
		// A disconnected adapter may notify synchronously during subscription.
		if (this.#state === 'terminal') unsubscribe()
		else this.#unsubscribeDisconnect = unsubscribe
	}

	get id(): string {
		return this.#caller.id
	}

	get state(): RuntimeCallState {
		return this.#state
	}

	get signal(): AbortSignal {
		return this.#controller.signal
	}

	get cancellationCause(): CallCancellationCause | undefined {
		return this.#cancellationCause
	}

	get settled(): Promise<void> {
		return this.#settledPromise
	}

	queue(): boolean {
		if (this.#state !== 'accepted') return false
		this.#state = 'queued'
		return true
	}

	onTerminal(listener: () => void): () => void {
		this.#terminalListeners.add(listener)
		return () => this.#terminalListeners.delete(listener)
	}

	async execute(run: Executor): Promise<void> {
		if (this.#state !== 'queued') return
		this.#state = 'active'
		try {
			const result = await run(this.#controller.signal)
			await this.#finish({
				frame: { requestId: this.id, kind: 'result', result },
			})
		} catch (error) {
			await this.#finish({
				frame: {
					requestId: this.id,
					kind: 'error',
					error: operationError(error),
				},
			})
		}
	}

	async cancel(cause: CallCancellationCause): Promise<void> {
		const frame: RuntimeFrame | undefined =
			cause === 'timeout'
				? {
						requestId: this.id,
						kind: 'error',
						error: { code: 'timeout', message: 'Runtime Call timed out.' },
					}
				: cause === 'runtime-stopping'
					? {
							requestId: this.id,
							kind: 'error',
							error: {
								code: 'cancelled',
								message: 'MCP Runtime is stopping.',
							},
						}
					: undefined
		await this.#finish({ cause, abort: true, frame })
	}

	async fail(error: RuntimeError): Promise<void> {
		await this.#finish({
			frame: { requestId: this.id, kind: 'error', error },
		})
	}

	async #finish(options: {
		cause?: CallCancellationCause
		abort?: boolean
		frame?: RuntimeFrame
	}): Promise<void> {
		if (this.#state === 'terminal') return

		this.#state = 'terminal'
		this.#cancellationCause = options.cause
		this.#unsubscribeDisconnect()
		if (options.abort && !this.#controller.signal.aborted) {
			this.#controller.abort(new RuntimeCallCancelled(options.cause))
		}
		for (const listener of [...this.#terminalListeners]) listener()
		this.#terminalListeners.clear()
		this.#resolveSettled()

		if (options.frame && this.#callerConnected) {
			await this.#caller.send(options.frame)
		}
	}
}

export class CancelableFifo {
	readonly #entries: QueueEntry[] = []
	#active: RuntimeCall | undefined
	#draining: Promise<void> | undefined

	enqueue(call: RuntimeCall, execute: Executor): void {
		if (!call.queue()) return
		const entry: QueueEntry = {
			call,
			execute,
			unsubscribeTerminal: () => {},
		}
		entry.unsubscribeTerminal = call.onTerminal(() => {
			const index = this.#entries.indexOf(entry)
			if (index !== -1) this.#entries.splice(index, 1)
		})
		this.#entries.push(entry)
		this.#ensureDraining()
	}

	status(): { activeCalls: number; queuedCalls: number } {
		return {
			activeCalls: this.#active ? 1 : 0,
			queuedCalls: this.#entries.length,
		}
	}

	async idle(): Promise<void> {
		while (this.#draining) await this.#draining
	}

	async cancelAll(cause: CallCancellationCause): Promise<void> {
		const calls = [
			this.#active,
			...this.#entries.map((entry) => entry.call),
		].filter((call): call is RuntimeCall => call !== undefined)
		await Promise.all(calls.map((call) => call.cancel(cause)))
		await this.idle()
	}

	#ensureDraining(): void {
		if (this.#draining) return
		this.#draining = this.#drain().finally(() => {
			this.#draining = undefined
			if (this.#entries.length > 0) this.#ensureDraining()
		})
	}

	async #drain(): Promise<void> {
		while (this.#entries.length > 0) {
			const entry = this.#entries.shift()
			if (!entry) return
			entry.unsubscribeTerminal()
			if (entry.call.state === 'terminal') continue

			this.#active = entry.call
			try {
				// Queue ownership ends at terminal transition, not at socket delivery.
				void entry.call.execute(entry.execute)
				await entry.call.settled
			} finally {
				this.#active = undefined
			}
		}
	}
}

class RuntimeCallCancelled extends Error {
	constructor(cause: CallCancellationCause | undefined) {
		super(`Runtime Call cancelled: ${cause ?? 'unknown'}.`)
		this.name = 'RuntimeCallCancelled'
	}
}

function operationError(error: unknown): RuntimeError {
	if (error instanceof RuntimeOperationError) {
		return { code: error.code, message: error.message }
	}
	return {
		code: 'operation-failed',
		message: error instanceof Error ? error.message : String(error),
	}
}
