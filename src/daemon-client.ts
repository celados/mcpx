import net from 'node:net'

import { requestJsonLine } from './daemon-io'
import { ensureDaemonDir, daemonSocketPath } from './daemon-paths'
import {
	DAEMON_PROTOCOL_VERSION,
	helloMessage,
	type DaemonMessage,
} from './daemon-protocol'
import { MCPX_VERSION } from './version'

const START_TIMEOUT_MS = 3_000
const CONNECT_RETRY_MS = 50

export async function ensureDaemon(mainPath: string): Promise<void> {
	const state = await probeDaemon()
	if (state === 'compatible') return
	if (state === 'incompatible') {
		try {
			await stopIncompatibleDaemon()
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(`Failed to stop incompatible mcpxd: ${message}`)
		}
	}

	await ensureDaemonDir()
	Bun.spawn([process.execPath, mainPath, '@daemon', 'server'], {
		env: { ...process.env, MCPX_DAEMON_SERVER: '1' },
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
	}).unref()

	const deadline = Date.now() + START_TIMEOUT_MS
	while (Date.now() < deadline) {
		if ((await probeDaemon()) === 'compatible') return
		await Bun.sleep(CONNECT_RETRY_MS)
	}
	throw new Error('mcpxd did not start before the startup timeout.')
}

export async function connectDaemonSocket(): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(daemonSocketPath())
		socket.once('connect', () => resolve(socket))
		socket.once('error', reject)
	})
}

async function probeDaemon(): Promise<
	'compatible' | 'incompatible' | 'missing'
> {
	let socket: net.Socket | undefined
	try {
		socket = await connectDaemonSocket()
		const response = await requestJsonLine(socket, helloMessage())
		if (!isDaemonMessage(response) || !response.ok) return 'incompatible'
		const result = response.result as
			| { protocolVersion?: unknown; version?: unknown }
			| undefined
		return response.protocolVersion === DAEMON_PROTOCOL_VERSION &&
			result?.protocolVersion === DAEMON_PROTOCOL_VERSION &&
			result.version === MCPX_VERSION
			? 'compatible'
			: 'incompatible'
	} catch {
		return 'missing'
	} finally {
		socket?.destroy()
	}
}

async function stopIncompatibleDaemon(): Promise<void> {
	const socket = await connectDaemonSocket()
	try {
		const hello = await requestJsonLine(socket, helloMessage())
		if (
			isDaemonMessage(hello) &&
			hello.ok &&
			hello.protocolVersion === DAEMON_PROTOCOL_VERSION
		) {
			await requestJsonLine(socket, {
				requestId: crypto.randomUUID(),
				op: 'stop',
			})
		} else {
			// V2 accepts its stop command after returning protocol-mismatch.
			await requestJsonLine(socket, { op: 'stop' })
		}
	} finally {
		socket.end()
	}

	const deadline = Date.now() + START_TIMEOUT_MS
	while (Date.now() < deadline) {
		if ((await probeDaemon()) === 'missing') return
		await Bun.sleep(CONNECT_RETRY_MS)
	}
	throw new Error('Incompatible mcpxd did not stop before the timeout.')
}

function isDaemonMessage(value: unknown): value is DaemonMessage {
	return !!value && typeof value === 'object' && 'ok' in value
}
