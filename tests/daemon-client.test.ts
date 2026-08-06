import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { connectDaemonSocket } from '../src/daemon-client'
import { requestJsonLine, writeJsonLine } from '../src/daemon-io'
import { daemonSocketPath } from '../src/daemon-paths'
import { helloMessage } from '../src/daemon-protocol'
import { requestRuntime } from '../src/runtime-client'

const mainPath = path.join(import.meta.dir, '..', 'src', 'main.ts')

describe('MCP Runtime process client', () => {
	let previousHome: string | undefined
	let previousMcpxHome: string | undefined
	let home: string
	let fakeDaemon: net.Server | undefined

	beforeEach(async () => {
		previousHome = process.env.HOME
		previousMcpxHome = process.env.MCPX_HOME
		home = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-runtime-client-'))
		process.env.HOME = home
		process.env.MCPX_HOME = home
	})

	afterEach(async () => {
		await requestRuntime(
			{ requestId: crypto.randomUUID(), op: 'stop' },
			mainPath,
			{ start: false },
		).catch(() => {})
		await stopFakeDaemon()
		await fs.rm(home, { recursive: true, force: true })
		if (previousHome === undefined) delete process.env.HOME
		else process.env.HOME = previousHome
		if (previousMcpxHome === undefined) delete process.env.MCPX_HOME
		else process.env.MCPX_HOME = previousMcpxHome
	})

	it('starts the Runtime on demand with a private socket', async () => {
		const status = (await requestRuntime(
			{ requestId: crypto.randomUUID(), op: 'status' },
			mainPath,
		)) as { protocolVersion: number; activeServers: number }

		expect(status.protocolVersion).toBe(3)
		expect(status.activeServers).toBe(0)
		expect((await fs.stat(daemonSocketPath())).mode & 0o777).toBe(0o600)
	})

	it('stops an older protocol daemon before starting v3', async () => {
		await startFakeDaemon({ protocolVersion: 2, version: '0.0.0' })

		const status = (await requestRuntime(
			{ requestId: crypto.randomUUID(), op: 'status' },
			mainPath,
		)) as { protocolVersion: number }

		expect(status.protocolVersion).toBe(3)
		expect(fakeDaemon).toBeUndefined()
	})

	it('stops an older same-protocol Runtime before restart', async () => {
		await startFakeDaemon({ protocolVersion: 3, version: '0.0.0' })

		const status = (await requestRuntime(
			{ requestId: crypto.randomUUID(), op: 'status' },
			mainPath,
		)) as { version: string }

		expect(status.version).not.toBe('0.0.0')
		expect(fakeDaemon).toBeUndefined()
	})

	it('rejects a second operation on the same connection', async () => {
		await requestRuntime(
			{ requestId: crypto.randomUUID(), op: 'status' },
			mainPath,
		)
		const socket = await connectDaemonSocket()
		try {
			expect(await requestJsonLine(socket, helloMessage())).toMatchObject({
				ok: true,
				protocolVersion: 3,
			})
			expect(
				await requestJsonLine(socket, { requestId: 'first', op: 'status' }),
			).toMatchObject({ requestId: 'first', kind: 'result' })
			expect(
				await requestJsonLine(socket, { requestId: 'second', op: 'status' }),
			).toMatchObject({
				ok: false,
				error: { code: 'connection-complete' },
			})
		} finally {
			socket.destroy()
		}
	})

	it('returns a terminal error when Runtime state loading fails', async () => {
		await requestRuntime(
			{ requestId: crypto.randomUUID(), op: 'status' },
			mainPath,
		)
		const registryPath = path.join(
			home,
			'.agents',
			'mcpx',
			'state-v2',
			'registry.json',
		)
		const original = await fs.readFile(registryPath, 'utf8')
		await fs.writeFile(registryPath, '{invalid')
		try {
			await expect(
				requestRuntime(
					{ requestId: 'broken-state', op: 'registrySnapshot' },
					mainPath,
				),
			).rejects.toThrow()
		} finally {
			await fs.writeFile(registryPath, original)
		}
	})

	it('rejects when a daemon closes before sending a terminal frame', async () => {
		await startFakeDaemon({
			protocolVersion: 3,
			version: '0.9.15',
			closeOnIntent: true,
		})

		await expect(
			requestRuntime({ requestId: 'closed', op: 'status' }, mainPath, {
				start: false,
			}),
		).rejects.toThrow('closed before a terminal frame')
	})

	it('aborts an active CLI input provider after the terminal frame', async () => {
		await startFakeDaemon({
			protocolVersion: 3,
			version: '0.9.15',
			inputThenTerminal: true,
		})
		let inputAborted = false

		await requestRuntime(
			{ requestId: 'input-cleanup', op: 'status' },
			mainPath,
			{
				start: false,
				onInput: async (_request, signal) =>
					new Promise((resolve) => {
						signal.addEventListener(
							'abort',
							() => {
								inputAborted = true
								resolve({ cancelled: true })
							},
							{ once: true },
						)
					}),
			},
		)

		expect(inputAborted).toBe(true)
	})

	async function startFakeDaemon(options: {
		protocolVersion: number
		version: string
		closeOnIntent?: boolean
		inputThenTerminal?: boolean
	}): Promise<void> {
		await fs.mkdir(path.dirname(daemonSocketPath()), { recursive: true })
		fakeDaemon = net.createServer((socket) => {
			let buffer = ''
			socket.on('data', (chunk) => {
				buffer += chunk.toString('utf8')
				while (buffer.includes('\n')) {
					const newline = buffer.indexOf('\n')
					const message = JSON.parse(buffer.slice(0, newline)) as {
						op?: string
						requestId?: string
					}
					buffer = buffer.slice(newline + 1)
					if (message.op === 'hello') {
						writeJsonLine(socket, {
							ok: true,
							protocolVersion: options.protocolVersion,
							result: options,
						})
					} else if (message.op === 'stop') {
						writeJsonLine(
							socket,
							message.requestId
								? {
										requestId: message.requestId,
										kind: 'result',
										result: { stopping: true },
									}
								: { ok: true, result: { stopping: true } },
						)
						void stopFakeDaemon()
					} else if (options.closeOnIntent) {
						socket.destroy()
					} else if (options.inputThenTerminal && message.requestId) {
						writeJsonLine(socket, {
							requestId: message.requestId,
							kind: 'event',
							event: {
								type: 'input-required',
								data: {
									inputId: 'input-1',
									type: 'oauth-client',
									serverName: 'fixture',
									redirectUri: 'http://127.0.0.1/callback',
									issuer: 'http://127.0.0.1',
									scopes: [],
								},
							},
						})
						writeJsonLine(socket, {
							requestId: message.requestId,
							kind: 'result',
							result: { done: true },
						})
					}
				}
			})
		})
		await new Promise<void>((resolve, reject) => {
			fakeDaemon?.once('error', reject)
			fakeDaemon?.listen(daemonSocketPath(), resolve)
		})
	}

	async function stopFakeDaemon(): Promise<void> {
		const server = fakeDaemon
		fakeDaemon = undefined
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
		await fs.rm(daemonSocketPath(), { force: true }).catch(() => {})
	}
})
