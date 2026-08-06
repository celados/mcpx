import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { McpConnection } from '../src/mcp-client'
import type { ServerConfig } from '../src/types'

import { RuntimeCall } from '../src/runtime-call'
import { createInMemoryRuntimeCaller } from '../src/runtime-caller'
import { RuntimeSessionPool } from '../src/runtime-session-pool'
import { openRuntimeStores } from '../src/runtime-stores'

type CancellationScenario =
	| 'acknowledge'
	| 'ignore'
	| 'race'
	| 'complete-before-cancel'

const cancellationScenarios: CancellationScenario[] = [
	'acknowledge',
	'ignore',
	'race',
	'complete-before-cancel',
]

describe('Runtime session pool', () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(
			roots.splice(0).map((root) => fs.rm(root, { recursive: true })),
		)
	})

	it('resolves declarations and credentials inside the Runtime', async () => {
		const stores = await createStores({
			url: 'http://127.0.0.1:1/mcp',
			headers: { 'x-api-key': 'header-secret' },
			auth: {
				kind: 'bearer',
				strategy: 'round-robin',
				confidence: 'configured',
				credentials: [{ kind: 'literal', value: 'bearer-secret' }],
			},
		})
		let connectedServer: ServerConfig | undefined
		let connectedHeaders: Record<string, string> | undefined
		let receivedSignal: AbortSignal | undefined
		const pool = new RuntimeSessionPool(stores, {
			connect: async (server, options) => {
				connectedServer = server
				connectedHeaders = options?.headers
				return fakeConnection(async (_params, _schema, requestOptions) => {
					receivedSignal = requestOptions?.signal
					return 'ok'
				})
			},
		})
		const caller = createInMemoryRuntimeCaller('request-1')
		const call = new RuntimeCall(caller)

		await pool.call(call, {
			serverName: 'fixture',
			toolName: 'echo',
			input: {},
		})

		expect(connectedServer).toEqual({
			url: 'http://127.0.0.1:1/mcp',
			auth: { kind: 'none' },
		})
		expect(connectedHeaders).toEqual({
			Accept: 'application/json, text/event-stream',
			Authorization: 'Bearer bearer-secret',
			'x-api-key': 'header-secret',
		})
		expect(receivedSignal).toBe(call.signal)
		expect(JSON.stringify(caller.frames)).not.toContain('secret')
	})

	it('removes queued calls and reuses the session after active cancellation', async () => {
		const stores = await createStores({
			transport: 'stdio',
			command: process.execPath,
			auth: undefined,
		})
		let connectCount = 0
		const upstreamCalls: string[] = []
		const pool = new RuntimeSessionPool(stores, {
			connect: async () => {
				connectCount += 1
				return fakeConnection(async (params, _schema, options) => {
					upstreamCalls.push(params.name)
					if (params.name === 'hold') {
						return new Promise((_resolve, reject) => {
							options?.signal?.addEventListener(
								'abort',
								() => reject(options.signal?.reason),
								{ once: true },
							)
						})
					}
					return 'echo-ok'
				})
			},
		})
		const activeCaller = createInMemoryRuntimeCaller('active')
		const queuedCaller = createInMemoryRuntimeCaller('queued')
		const active = pool.call(new RuntimeCall(activeCaller), {
			serverName: 'fixture',
			toolName: 'hold',
			input: {},
		})
		await waitFor(() => upstreamCalls.length === 1)
		const queued = pool.call(new RuntimeCall(queuedCaller), {
			serverName: 'fixture',
			toolName: 'never',
			input: {},
		})

		queuedCaller.disconnect()
		activeCaller.disconnect()
		await Promise.all([active, queued])

		const reuseCaller = createInMemoryRuntimeCaller('reuse')
		await pool.call(new RuntimeCall(reuseCaller), {
			serverName: 'fixture',
			toolName: 'echo',
			input: {},
		})

		expect(connectCount).toBe(1)
		expect(upstreamCalls).toEqual(['hold', 'echo'])
		expect(activeCaller.frames).toEqual([])
		expect(queuedCaller.frames).toEqual([])
		expect(reuseCaller.frames[0]).toMatchObject({
			kind: 'result',
			result: { result: 'echo-ok' },
		})
	})

	it('maps 401 to reauth-required without starting authentication', async () => {
		const stores = await createStores({
			url: 'http://127.0.0.1:1/mcp',
			auth: { kind: 'none' },
		})
		let closed = 0
		const pool = new RuntimeSessionPool(stores, {
			connect: async () =>
				fakeConnection(
					async () => {
						throw new Error('HTTP 401 Unauthorized')
					},
					() => closed++,
				),
		})
		const caller = createInMemoryRuntimeCaller('request-1')

		await pool.call(new RuntimeCall(caller), {
			serverName: 'fixture',
			toolName: 'echo',
			input: {},
		})

		expect(caller.frames).toEqual([
			{
				requestId: 'request-1',
				kind: 'error',
				error: {
					code: 'reauth-required',
					message: 'Credentials for fixture must be refreshed.',
				},
			},
		])
		expect(closed).toBe(1)
	})

	it('rotates bearer credentials only at queued-to-active ownership', async () => {
		const stores = await createStores({
			url: 'http://127.0.0.1:1/mcp',
			auth: {
				kind: 'bearer',
				strategy: 'round-robin',
				confidence: 'configured',
				credentials: [
					{ kind: 'literal', value: 'token-a' },
					{ kind: 'literal', value: 'token-b' },
				],
			},
		})
		let authorization = ''
		let releaseFirst = () => {}
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const observed: string[] = []
		const pool = new RuntimeSessionPool(stores, {
			connect: async (_server, options) => {
				authorization = options?.headers?.Authorization ?? ''
				return {
					...fakeConnection(async (params) => {
						observed.push(`${params.name}:${authorization}`)
						if (params.name === 'first') await firstBlocked
						return 'ok'
					}),
					updateHeaders: (headers) => {
						authorization = headers.Authorization ?? ''
					},
				}
			},
		})
		const first = pool.call(
			new RuntimeCall(createInMemoryRuntimeCaller('first')),
			{
				serverName: 'fixture',
				toolName: 'first',
				input: {},
			},
		)
		await waitFor(() => observed.length === 1)
		const second = pool.call(
			new RuntimeCall(createInMemoryRuntimeCaller('second')),
			{
				serverName: 'fixture',
				toolName: 'second',
				input: {},
			},
		)
		await Bun.sleep(5)
		expect(observed).toEqual(['first:Bearer token-a'])
		releaseFirst()
		await Promise.all([first, second])
		expect(observed).toEqual(['first:Bearer token-a', 'second:Bearer token-b'])
	})

	it('owns the timeout cause instead of inferring it from the SDK error', async () => {
		const previous = process.env.MCPX_TOOL_CALL_TIMEOUT_MS
		process.env.MCPX_TOOL_CALL_TIMEOUT_MS = '5'
		try {
			const stores = await createStores({
				transport: 'stdio',
				command: process.execPath,
			})
			const pool = new RuntimeSessionPool(stores, {
				connect: async () =>
					fakeConnection(
						async (_params, _schema, options) =>
							new Promise((_resolve, reject) => {
								options?.signal?.addEventListener(
									'abort',
									() => reject(new Error('SDK -32001')),
									{ once: true },
								)
							}),
					),
			})
			const caller = createInMemoryRuntimeCaller('timeout-owned')
			const call = new RuntimeCall(caller)

			const settlement = await Promise.race([
				pool
					.call(call, {
						serverName: 'fixture',
						toolName: 'hold',
						input: {},
					})
					.then(() => 'settled'),
				Bun.sleep(50).then(() => 'deadline'),
			])

			expect(settlement).toBe('settled')
			expect(call.cancellationCause).toBe('timeout')
			expect(caller.frames[0]).toMatchObject({
				kind: 'error',
				error: { code: 'timeout' },
			})
		} finally {
			if (previous === undefined) delete process.env.MCPX_TOOL_CALL_TIMEOUT_MS
			else process.env.MCPX_TOOL_CALL_TIMEOUT_MS = previous
		}
	})

	it('preserves one stdio SDK connection across cancellation races and late responses', async () => {
		const stores = await createStores({
			transport: 'stdio',
			command: process.execPath,
			args: [
				path.join(
					import.meta.dir,
					'..',
					'prototypes',
					'mcp-cancellation',
					'stdio-fixture.mjs',
				),
			],
		})
		const pool = new RuntimeSessionPool(stores)
		try {
			await runCancellationMatrix(pool)
		} finally {
			await pool.close()
		}
	})

	it('preserves one Streamable HTTP session across cancellation races and late responses', async () => {
		const fixture = startCancellationHttpFixture()
		const stores = await createStores({
			url: fixture.url,
			auth: { kind: 'none' },
		})
		const pool = new RuntimeSessionPool(stores)
		try {
			await runCancellationMatrix(pool)
			const initializedSessions = fixture.sessionIds.filter(Boolean)
			expect(new Set(initializedSessions)).toEqual(new Set(['local-session']))
		} finally {
			await pool.close()
			fixture.stop()
		}
	})

	it('closes idle sessions and rejects admission after shutdown', async () => {
		const stores = await createStores({
			transport: 'stdio',
			command: process.execPath,
		})
		let closes = 0
		const pool = new RuntimeSessionPool(stores, {
			connect: async () =>
				fakeConnection(
					async () => 'ok',
					() => closes++,
				),
		})
		await pool.call(new RuntimeCall(createInMemoryRuntimeCaller('first')), {
			serverName: 'fixture',
			toolName: 'echo',
			input: {},
		})

		await pool.cleanupIdle(0)
		expect(pool.sessionCount()).toBe(0)
		expect(closes).toBe(1)
		await pool.close()
		const rejected = createInMemoryRuntimeCaller('rejected')
		await expect(
			pool.call(new RuntimeCall(rejected), {
				serverName: 'fixture',
				toolName: 'echo',
				input: {},
			}),
		).rejects.toThrow('stopping')
	})

	it('cancels active and queued Calls before shutdown releases the pool', async () => {
		const stores = await createStores({
			transport: 'stdio',
			command: process.execPath,
		})
		const pool = new RuntimeSessionPool(stores, {
			connect: async () =>
				fakeConnection(
					async (_params, _schema, options) =>
						new Promise((_resolve, reject) => {
							options?.signal?.addEventListener(
								'abort',
								() => reject(options.signal?.reason),
								{ once: true },
							)
						}),
				),
		})
		const activeCaller = createInMemoryRuntimeCaller('active-stop')
		const queuedCaller = createInMemoryRuntimeCaller('queued-stop')
		const active = pool.call(new RuntimeCall(activeCaller), {
			serverName: 'fixture',
			toolName: 'hold',
			input: {},
		})
		await waitFor(() => pool.status()[0]?.activeCalls === 1)
		const queued = pool.call(new RuntimeCall(queuedCaller), {
			serverName: 'fixture',
			toolName: 'queued',
			input: {},
		})
		await waitFor(() => pool.status()[0]?.queuedCalls === 1)

		await pool.close()
		await Promise.all([active, queued])

		expect(activeCaller.frames[0]).toMatchObject({
			kind: 'error',
			error: { code: 'cancelled' },
		})
		expect(queuedCaller.frames[0]).toMatchObject({
			kind: 'error',
			error: { code: 'cancelled' },
		})
		expect(pool.status()).toEqual([])
	})

	it('rechecks admission after a delayed store read before creating a session', async () => {
		const stores = await createStores({
			transport: 'stdio',
			command: process.execPath,
		})
		const originalReadState = stores.readState
		let readStarted = false
		let releaseRead = () => {}
		const readBlocked = new Promise<void>((resolve) => {
			releaseRead = resolve
		})
		const delayedStores = {
			...stores,
			readState: async () => {
				readStarted = true
				await readBlocked
				return originalReadState()
			},
		}
		let connects = 0
		const pool = new RuntimeSessionPool(delayedStores, {
			connect: async () => {
				connects += 1
				return fakeConnection(async () => 'ok')
			},
		})
		const run = pool.call(
			new RuntimeCall(createInMemoryRuntimeCaller('late-admission')),
			{
				serverName: 'fixture',
				toolName: 'echo',
				input: {},
			},
		)
		await waitFor(() => readStarted)

		await pool.close()
		releaseRead()

		await expect(run).rejects.toThrow('stopping')
		expect(connects).toBe(0)
		expect(pool.sessionCount()).toBe(0)
	})

	it('closes a connection that resolves after shutdown has begun', async () => {
		const stores = await createStores({
			transport: 'stdio',
			command: process.execPath,
		})
		let releaseConnect = () => {}
		let connectStarted = false
		let closes = 0
		const connection = fakeConnection(
			async () => 'ok',
			() => closes++,
		)
		const pool = new RuntimeSessionPool(stores, {
			connect: async () => {
				connectStarted = true
				await new Promise<void>((resolve) => {
					releaseConnect = resolve
				})
				return connection
			},
		})
		const run = pool.call(
			new RuntimeCall(createInMemoryRuntimeCaller('late-connect')),
			{
				serverName: 'fixture',
				toolName: 'echo',
				input: {},
			},
		)
		await waitFor(() => connectStarted)
		const closing = pool.close()
		await Bun.sleep(2)

		releaseConnect()
		await Promise.all([run, closing])

		expect(closes).toBe(1)
		expect(pool.sessionCount()).toBe(0)
	})

	it('never starts a connection after shutdown completes during header resolution', async () => {
		const stores = await createStores({
			transport: 'stdio',
			command: process.execPath,
		})
		const originalReadState = stores.readState
		let reads = 0
		let headerReadStarted = false
		let releaseHeaderRead = () => {}
		const headerReadBlocked = new Promise<void>((resolve) => {
			releaseHeaderRead = resolve
		})
		const delayedStores = {
			...stores,
			readState: async () => {
				reads += 1
				if (reads === 2) {
					headerReadStarted = true
					await headerReadBlocked
				}
				return originalReadState()
			},
		}
		let connects = 0
		const pool = new RuntimeSessionPool(delayedStores, {
			connect: async () => {
				connects += 1
				return fakeConnection(async () => 'ok')
			},
		})
		const run = pool.call(
			new RuntimeCall(createInMemoryRuntimeCaller('header-stop')),
			{
				serverName: 'fixture',
				toolName: 'echo',
				input: {},
			},
		)
		await waitFor(() => headerReadStarted)

		await pool.close()
		releaseHeaderRead()
		await run
		await Bun.sleep(2)

		expect(connects).toBe(0)
		expect(pool.sessionCount()).toBe(0)
	})

	async function createStores(server: Record<string, unknown>) {
		const root = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-session-pool-'))
		roots.push(root)
		const normalized = { ...server }
		if (normalized.transport === 'stdio') delete normalized.auth
		await fs.writeFile(
			path.join(root, 'servers.json'),
			JSON.stringify({ version: 1, servers: { fixture: normalized } }),
		)
		return openRuntimeStores(root)
	}
})

async function runCancellationMatrix(pool: RuntimeSessionPool): Promise<void> {
	for (const scenario of cancellationScenarios) {
		const caller = createInMemoryRuntimeCaller(`controlled-${scenario}`)
		const call = new RuntimeCall(caller)
		const execution = pool.call(call, {
			serverName: 'fixture',
			toolName: 'controlled',
			input: { scenario },
		})

		if (scenario === 'complete-before-cancel') {
			await execution
			caller.disconnect()
			expect(call.signal.aborted).toBe(false)
		} else {
			await Bun.sleep(15)
			caller.disconnect()
			await execution
			expect(call.cancellationCause).toBe('caller-disconnected')
			expect(caller.frames).toEqual([])
		}

		expect(await echoThroughPool(pool, `${scenario}-before-late`)).toBe(
			'echo-ok',
		)
		await Bun.sleep(scenario === 'ignore' ? 110 : 35)
		expect(await echoThroughPool(pool, `${scenario}-after-late`)).toBe(
			'echo-ok',
		)
	}
}

async function echoThroughPool(
	pool: RuntimeSessionPool,
	requestId: string,
): Promise<string> {
	const caller = createInMemoryRuntimeCaller(requestId)
	await pool.call(new RuntimeCall(caller), {
		serverName: 'fixture',
		toolName: 'echo',
		input: {},
	})
	const frame = caller.frames[0]
	if (!frame || frame.kind !== 'result') throw new Error('Missing echo result.')
	const callResult = frame.result as { result?: unknown }
	const mcpResult = callResult.result as {
		content?: Array<{ type?: string; text?: string }>
	}
	return mcpResult.content?.[0]?.text ?? String(callResult.result)
}

function startCancellationHttpFixture(): {
	url: string
	sessionIds: Array<string | null>
	stop: () => void
} {
	type Pending = {
		scenario: CancellationScenario
		resolve: (response: Response) => void
		timer: Timer
	}
	const pending = new Map<string | number, Pending>()
	const sessionIds: Array<string | null> = []
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			if (request.method !== 'POST') return new Response(null, { status: 405 })
			const message = (await request.json()) as {
				id?: string | number
				method: string
				params?: Record<string, any>
			}
			sessionIds.push(request.headers.get('mcp-session-id'))
			if (message.method === 'initialize') {
				return rpcResponse(message.id, {
					protocolVersion: message.params?.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: 'local-http-fixture', version: '1.0.0' },
				})
			}
			if (message.method === 'notifications/initialized') {
				return acceptedResponse()
			}
			if (message.method === 'notifications/cancelled') {
				const requestId = message.params?.requestId as string | number
				const entry = pending.get(requestId)
				if (entry?.scenario === 'acknowledge' || entry?.scenario === 'race') {
					clearTimeout(entry.timer)
					pending.delete(requestId)
					entry.resolve(rpcResponse(requestId, toolResult(entry.scenario)))
				}
				return acceptedResponse()
			}
			if (message.method !== 'tools/call') return acceptedResponse()
			if (message.params?.name === 'echo') {
				return rpcResponse(message.id, toolResult('echo-ok'))
			}

			const id = message.id
			if (id === undefined) return acceptedResponse()
			const scenario = message.params?.arguments
				?.scenario as CancellationScenario
			if (scenario === 'complete-before-cancel') {
				await Bun.sleep(5)
				return rpcResponse(id, toolResult(scenario))
			}
			return new Promise<Response>((resolve) => {
				const timer = setTimeout(
					() => {
						pending.delete(id)
						resolve(rpcResponse(id, toolResult(scenario)))
					},
					scenario === 'ignore' ? 80 : 2_000,
				)
				pending.set(id, { scenario, resolve, timer })
			})
		},
	})
	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		sessionIds,
		stop: () => server.stop(true),
	}
}

function acceptedResponse(): Response {
	return new Response(null, {
		status: 202,
		headers: { 'mcp-session-id': 'local-session' },
	})
}

function rpcResponse(id: unknown, result: unknown): Response {
	return Response.json(
		{ jsonrpc: '2.0', id, result },
		{ headers: { 'mcp-session-id': 'local-session' } },
	)
}

function toolResult(text: string): Record<string, unknown> {
	return { content: [{ type: 'text', text }] }
}

function fakeConnection(
	callTool: (...args: any[]) => Promise<unknown>,
	onClose: () => void = () => {},
): McpConnection {
	return {
		client: { callTool } as McpConnection['client'],
		close: async () => onClose(),
		pid: () => null,
		stderr: null,
		sessionId: () => 'fixture-session',
		updateHeaders: () => {},
	}
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return
		await Bun.sleep(1)
	}
	throw new Error('Condition was not met.')
}
