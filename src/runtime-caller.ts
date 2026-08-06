import type { Socket } from 'node:net'

import type {
	RuntimeFrame,
	RuntimeInputFrame,
	RuntimeInputRequest,
} from './runtime-protocol'

export type RuntimeCaller = {
	id: string
	onDisconnect: (listener: () => void) => () => void
	requestInput: (
		request: Omit<RuntimeInputRequest, 'inputId'>,
		signal?: AbortSignal,
	) => Promise<unknown>
	send: (frame: RuntimeFrame) => Promise<void>
}

export type InMemoryRuntimeCaller = RuntimeCaller & {
	frames: RuntimeFrame[]
	disconnect: () => void
}

export type SocketRuntimeCaller = RuntimeCaller & {
	receiveInput: (frame: RuntimeInputFrame) => void
}

type FrameWriter = (frame: RuntimeFrame) => Promise<void>

export function createInMemoryRuntimeCaller(
	requestId: string,
): InMemoryRuntimeCaller {
	const frames: RuntimeFrame[] = []
	const disconnectListeners = new Set<() => void>()
	let disconnected = false
	const caller = createGuardedCaller(
		requestId,
		async (frame) => {
			frames.push(frame)
		},
		disconnectListeners,
		() => disconnected,
		async () => {
			throw new Error('In-memory caller has no input provider.')
		},
	)

	return {
		...caller,
		frames,
		disconnect: () => {
			if (disconnected) return
			disconnected = true
			for (const listener of [...disconnectListeners]) listener()
		},
	}
}

export function createSocketRuntimeCaller(
	requestId: string,
	socket: Socket,
): SocketRuntimeCaller {
	const disconnectListeners = new Set<() => void>()
	const inputWaiters = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>()
	let disconnected = socket.destroyed
	const notifyDisconnect = () => {
		if (disconnected) return
		disconnected = true
		for (const listener of [...disconnectListeners]) listener()
		for (const waiter of inputWaiters.values()) {
			waiter.reject(new Error(`Runtime caller ${requestId} is disconnected.`))
		}
		inputWaiters.clear()
	}
	socket.once('close', notifyDisconnect)

	const caller = createGuardedCaller(
		requestId,
		(frame) =>
			new Promise<void>((resolve, reject) => {
				if (disconnected || socket.destroyed) {
					reject(new Error(`Runtime caller ${requestId} is disconnected.`))
					return
				}
				socket.write(`${JSON.stringify(frame)}\n`, (error) => {
					if (error) reject(error)
					else resolve()
				})
			}),
		disconnectListeners,
		() => disconnected || socket.destroyed,
		(request, signal) => {
			const inputId = crypto.randomUUID()
			return new Promise((resolve, reject) => {
				const onAbort = () => {
					inputWaiters.delete(inputId)
					reject(signal?.reason ?? new Error('Runtime input cancelled.'))
				}
				if (signal?.aborted) {
					onAbort()
					return
				}
				inputWaiters.set(inputId, {
					resolve: (value) => {
						signal?.removeEventListener('abort', onAbort)
						resolve(value)
					},
					reject: (error) => {
						signal?.removeEventListener('abort', onAbort)
						reject(error)
					},
				})
				signal?.addEventListener('abort', onAbort, { once: true })
				void caller
					.send({
						requestId,
						kind: 'event',
						event: { type: 'input-required', data: { ...request, inputId } },
					})
					.catch((error) => {
						inputWaiters.delete(inputId)
						reject(error)
					})
			})
		},
	)
	return {
		...caller,
		receiveInput: (frame) => {
			if (frame.requestId !== requestId) return
			const waiter = inputWaiters.get(frame.inputId)
			if (!waiter) return
			inputWaiters.delete(frame.inputId)
			waiter.resolve(frame.value)
		},
	}
}

function createGuardedCaller(
	requestId: string,
	write: FrameWriter,
	disconnectListeners: Set<() => void>,
	isDisconnected: () => boolean,
	requestInput: RuntimeCaller['requestInput'],
): RuntimeCaller {
	let terminal = false
	return {
		id: requestId,
		requestInput,
		onDisconnect: (listener) => {
			if (isDisconnected()) {
				listener()
				return () => {}
			}
			disconnectListeners.add(listener)
			return () => disconnectListeners.delete(listener)
		},
		send: async (frame) => {
			if (frame.requestId !== requestId) {
				throw new Error(
					`Runtime frame ${frame.requestId} does not match caller ${requestId}.`,
				)
			}
			if (terminal) {
				throw new Error(
					`Runtime caller ${requestId} already received a terminal frame.`,
				)
			}
			await write(frame)
			if (frame.kind !== 'event') terminal = true
		},
	}
}
