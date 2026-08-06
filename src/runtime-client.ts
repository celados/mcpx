import type {
	RuntimeFrame,
	RuntimeInputRequest,
	RuntimeIntent,
} from './runtime-protocol'

import { connectDaemonSocket, ensureDaemon } from './daemon-client'
import { readJsonLines, requestJsonLine, writeJsonLine } from './daemon-io'
import { helloMessage } from './daemon-protocol'

export async function requestRuntime(
	intent: RuntimeIntent,
	mainPath: string,
	options: {
		start?: boolean
		onEvent?: (frame: RuntimeFrame) => void
		onInput?: (
			request: RuntimeInputRequest,
			signal: AbortSignal,
		) => Promise<unknown>
	} = {},
): Promise<unknown> {
	if (options.start ?? true) await ensureDaemon(mainPath)
	const socket = await connectDaemonSocket()
	try {
		const hello = await requestJsonLine(socket, helloMessage())
		if (!isCompatibleHello(hello)) {
			throw new Error('Invalid MCP Runtime handshake.')
		}
		return await new Promise((resolve, reject) => {
			let unsubscribe = () => {}
			const inputControllers = new Map<string, AbortController>()
			const cleanup = () => {
				for (const controller of inputControllers.values()) controller.abort()
				inputControllers.clear()
				unsubscribe()
				socket.off('error', onError)
				socket.off('close', onClose)
				socket.off('end', onClose)
			}
			const onError = (error: Error) => {
				cleanup()
				reject(error)
			}
			const onClose = () => {
				cleanup()
				reject(
					new Error('MCP Runtime connection closed before a terminal frame.'),
				)
			}
			socket.once('error', onError)
			socket.once('close', onClose)
			socket.once('end', onClose)
			unsubscribe = readJsonLines(
				socket,
				(value) => {
					if (!isRuntimeFrame(value) || value.requestId !== intent.requestId) {
						cleanup()
						reject(new Error('Invalid MCP Runtime frame.'))
						return
					}
					if (value.kind === 'event') {
						options.onEvent?.(value)
						const request = runtimeInputRequest(value)
						if (request) {
							const controller = new AbortController()
							inputControllers.set(request.inputId, controller)
							void respondToInput(
								socket,
								intent.requestId,
								request,
								options.onInput,
								controller.signal,
							).finally(() => inputControllers.delete(request.inputId))
						}
						return
					}
					cleanup()
					if (value.kind === 'error') reject(runtimeClientError(value))
					else resolve(value.result)
				},
				(error) => {
					cleanup()
					reject(error)
				},
			)
			writeJsonLine(socket, intent)
		})
	} finally {
		socket.end()
	}
}

async function respondToInput(
	socket: import('node:net').Socket,
	requestId: string,
	request: RuntimeInputRequest,
	provider:
		| ((request: RuntimeInputRequest, signal: AbortSignal) => Promise<unknown>)
		| undefined,
	signal: AbortSignal,
): Promise<void> {
	const value = provider
		? await provider(request, signal).catch((error) => ({
				cancelled: true,
				reason: error instanceof Error ? error.message : String(error),
			}))
		: { cancelled: true, reason: 'Interactive input is unavailable.' }
	if (signal.aborted || socket.destroyed || !socket.writable) return
	writeJsonLine(socket, {
		kind: 'input',
		requestId,
		inputId: request.inputId,
		value,
	})
}

function runtimeInputRequest(
	frame: Extract<RuntimeFrame, { kind: 'event' }>,
): RuntimeInputRequest | undefined {
	if (frame.event.type !== 'input-required') return undefined
	return frame.event.data as RuntimeInputRequest
}

function isCompatibleHello(value: unknown): boolean {
	return (
		!!value &&
		typeof value === 'object' &&
		'ok' in value &&
		(value as { ok?: unknown }).ok === true
	)
}

function isRuntimeFrame(value: unknown): value is RuntimeFrame {
	if (!value || typeof value !== 'object') return false
	const frame = value as { requestId?: unknown; kind?: unknown }
	return (
		typeof frame.requestId === 'string' &&
		(frame.kind === 'event' ||
			frame.kind === 'result' ||
			frame.kind === 'error')
	)
}

function runtimeClientError(
	frame: Extract<RuntimeFrame, { kind: 'error' }>,
): Error {
	const error = new Error(frame.error.message) as Error & { code?: string }
	error.code = frame.error.code
	return error
}
