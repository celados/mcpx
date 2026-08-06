import fs from 'node:fs/promises'
import net, { type Socket } from 'node:net'

import type { SocketRuntimeCaller } from './runtime-caller'

import { readJsonLines, requestJsonLine, writeJsonLine } from './daemon-io'
import { daemonDir, ensureDaemonDir, daemonSocketPath } from './daemon-paths'
import {
	DAEMON_PROTOCOL_VERSION,
	type ClientMessage,
	type DaemonMessage,
} from './daemon-protocol'
import { McpRuntime } from './runtime'
import { createSocketRuntimeCaller } from './runtime-caller'
import { isRuntimeInputFrame, parseRuntimeIntent } from './runtime-protocol'
import { openRuntimeStores } from './runtime-stores'
import { MCPX_VERSION } from './version'

let runtimePromise: Promise<McpRuntime> | undefined
let stopping = false
let lastActivityAt = Date.now()

const SESSION_IDLE_MS = 15 * 60 * 1000
const DAEMON_IDLE_MS = 30 * 60 * 1000
const CLEANUP_INTERVAL_MS = 30 * 1000

export async function runDaemonServer(): Promise<void> {
	await ensureDaemonDir()
	const socketPath = daemonSocketPath()
	if (await isLiveSocket(socketPath)) return
	await fs.rm(socketPath, { force: true }).catch(() => {})

	const server = net.createServer((socket) => handleConnection(server, socket))
	const cleanupTimer = setInterval(() => {
		void cleanupIdleRuntime(server)
	}, CLEANUP_INTERVAL_MS)
	cleanupTimer.unref()
	try {
		await listen(server, socketPath)
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code === 'EADDRINUSE' &&
			(await isLiveSocket(socketPath))
		) {
			return
		}
		throw error
	}

	await new Promise<void>((resolve) => server.on('close', resolve))
	clearInterval(cleanupTimer)
}

function handleConnection(server: net.Server, socket: Socket): void {
	let phase: 'awaiting-hello' | 'ready' | 'complete' = 'awaiting-hello'
	let pending = Promise.resolve()
	let activeCaller: SocketRuntimeCaller | undefined
	readJsonLines(
		socket,
		(message) => {
			lastActivityAt = Date.now()
			if (activeCaller && isRuntimeInputFrame(message)) {
				activeCaller.receiveInput(message)
				return
			}
			pending = pending.then(async () => {
				if (phase === 'complete') {
					writeJsonLine(
						socket,
						errorResponse(
							'connection-complete',
							'A Runtime connection accepts exactly one operation.',
						),
					)
					return
				}
				if (phase === 'awaiting-hello') {
					if (!isHelloMessage(message)) {
						writeJsonLine(
							socket,
							errorResponse(
								'handshake-required',
								'A Runtime connection must begin with a handshake.',
							),
						)
						return
					}
					if (message.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
						phase = 'complete'
						writeJsonLine(
							socket,
							errorResponse(
								'protocol-mismatch',
								`Unsupported mcpxd protocol ${message.protocolVersion}; expected ${DAEMON_PROTOCOL_VERSION}.`,
							),
						)
						return
					}
					phase = 'ready'
					writeJsonLine(socket, {
						ok: true,
						protocolVersion: DAEMON_PROTOCOL_VERSION,
						result: {
							protocolVersion: DAEMON_PROTOCOL_VERSION,
							version: MCPX_VERSION,
						},
					} satisfies DaemonMessage)
					return
				}

				phase = 'complete'
				const intent = parseRuntimeIntent(message)
				if ('code' in intent) {
					writeJsonLine(socket, errorResponse(intent.code, intent.message))
					return
				}
				if (stopping && intent.op !== 'stop') {
					writeJsonLine(
						socket,
						errorResponse('operation-failed', 'MCP Runtime is stopping.'),
					)
					return
				}
				if (intent.op === 'stop') stopping = true

				const caller = createSocketRuntimeCaller(intent.requestId, socket)
				activeCaller = caller
				try {
					const runtime = await getRuntime()
					await runtime.handle(intent, caller)
					if (intent.op === 'stop') await stopRuntime(server)
				} catch (error) {
					await caller
						.send({
							requestId: intent.requestId,
							kind: 'error',
							error: {
								code: 'operation-failed',
								message: error instanceof Error ? error.message : String(error),
							},
						})
						.catch(() => {})
				}
			})
		},
		(error) => {
			writeJsonLine(socket, errorResponse('invalid-json', error.message))
		},
	)
}

async function cleanupIdleRuntime(server: net.Server): Promise<void> {
	if (stopping || !runtimePromise) return
	const runtime = await runtimePromise
	await runtime.cleanupIdleSessions(SESSION_IDLE_MS)
	if (
		runtime.activeSessionCount() === 0 &&
		runtime.activeAuthenticationFlows() === 0 &&
		Date.now() - lastActivityAt >= DAEMON_IDLE_MS
	) {
		await stopRuntime(server)
	}
}

async function getRuntime(): Promise<McpRuntime> {
	runtimePromise ??= openRuntimeStores(daemonDir()).then(
		(stores) => new McpRuntime(stores),
	)
	return runtimePromise
}

async function stopRuntime(server: net.Server): Promise<void> {
	stopping = true
	await fs.rm(daemonSocketPath(), { force: true }).catch(() => {})
	server.close()
	process.exitCode = 0
}

function isHelloMessage(
	value: unknown,
): value is Extract<ClientMessage, { op: 'hello' }> {
	return (
		!!value &&
		typeof value === 'object' &&
		(value as { op?: unknown }).op === 'hello' &&
		typeof (value as { protocolVersion?: unknown }).protocolVersion ===
			'number' &&
		typeof (value as { clientVersion?: unknown }).clientVersion === 'string'
	)
}

function errorResponse(code: string, message: string): DaemonMessage {
	return { ok: false, error: { code, message } }
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(socketPath, () => {
			server.off('error', reject)
			fs.chmod(socketPath, 0o600).then(resolve, reject)
		})
	})
}

async function isLiveSocket(socketPath: string): Promise<boolean> {
	let socket: Socket | undefined
	try {
		socket = await new Promise<Socket>((resolve, reject) => {
			const candidate = net.createConnection(socketPath)
			candidate.once('connect', () => resolve(candidate))
			candidate.once('error', reject)
		})
		const parsed = (await requestJsonLine(socket, {
			op: 'hello',
			protocolVersion: DAEMON_PROTOCOL_VERSION,
			clientVersion: MCPX_VERSION,
		} satisfies ClientMessage)) as DaemonMessage
		return (
			parsed.ok === true && parsed.protocolVersion === DAEMON_PROTOCOL_VERSION
		)
	} catch {
		return false
	} finally {
		socket?.destroy()
	}
}
