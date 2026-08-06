import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'

type TransportName = 'stdio' | 'streamable-http'
type ScenarioName = 'acknowledge' | 'ignore' | 'race' | 'complete-before-cancel'

type FixtureEvent = Record<string, unknown> & { event: string }

type Settlement = {
	status: 'fulfilled' | 'rejected'
	elapsedMs: number
	text?: string
	error?: { name: string; code?: number; message: string }
}

type ScenarioEvidence = {
	scenario: ScenarioName
	settlement: Settlement
	reuseBeforeLate: string
	reuseAfterLate: string
	fixtureEvents: FixtureEvent[]
	clientErrors: string[]
}

type TransportEvidence = {
	transport: TransportName
	sessionIds?: Array<string | null>
	scenarios: ScenarioEvidence[]
}

type Evidence = {
	question: string
	runtime: { bun: string; sdk: string; sdkLock: string }
	abortReason: string
	transports: TransportEvidence[]
}

type Fixture = {
	client: Client
	events: FixtureEvent[]
	errors: string[]
	sessionIds?: Array<string | null>
	close: () => Promise<void>
}

type PendingHttpCall = {
	id: number | string
	scenario: ScenarioName
	controller: ReadableStreamDefaultController<Uint8Array>
	timer?: Timer
	requestAborted: boolean
}

const prototypeDir = import.meta.dir
const scenarios: ScenarioName[] = [
	'acknowledge',
	'ignore',
	'race',
	'complete-before-cancel',
]
const abortReason = 'originating CLI socket closed'
const encoder = new TextEncoder()

async function main(): Promise<void> {
	if (process.argv.includes('--evidence')) {
		const evidence = await runMatrix()
		const outputPath = path.join(prototypeDir, 'evidence.json')
		await fs.writeFile(outputPath, `${JSON.stringify(evidence, null, '\t')}\n`)
		console.log(JSON.stringify(summary(evidence), null, 2))
		console.log(`Evidence written to ${outputPath}`)
		return
	}

	await runInteractive()
}

async function runInteractive(): Promise<void> {
	const input = createInterface({
		input: process.stdin,
		output: process.stdout,
	})
	let state: Evidence | undefined
	try {
		while (true) {
			console.clear()
			console.log('\x1b[1mMCP cancellation prototype\x1b[0m')
			console.log(
				state
					? JSON.stringify(summary(state), null, 2)
					: '\x1b[2mNo run yet. All state is in memory.\x1b[0m',
			)
			console.log('\n\x1b[1m[a]\x1b[0m run all  \x1b[1m[q]\x1b[0m quit')
			const action = (await input.question('> ')).trim().toLowerCase()
			if (action === 'q') return
			if (action === 'a') state = await runMatrix()
		}
	} finally {
		input.close()
	}
}

async function runMatrix(): Promise<Evidence> {
	const sdkPackage = await Bun.file(
		path.join(
			prototypeDir,
			'../../node_modules/@modelcontextprotocol/sdk/package.json',
		),
	).json()
	const transports = await Promise.all([
		runTransport('stdio'),
		runTransport('streamable-http'),
	])
	return {
		question:
			'Can one caller-owned AbortSignal promptly cancel Client.callTool while preserving stdio and Streamable HTTP connection reuse?',
		runtime: {
			bun: Bun.version,
			sdk: sdkPackage.version,
			sdkLock: '@modelcontextprotocol/sdk@1.29.0',
		},
		abortReason,
		transports,
	}
}

async function runTransport(
	transport: TransportName,
): Promise<TransportEvidence> {
	const fixture =
		transport === 'stdio' ? await startStdioFixture() : await startHttpFixture()
	try {
		const evidence: ScenarioEvidence[] = []
		for (const scenario of scenarios) {
			evidence.push(await runScenario(fixture, scenario))
		}
		return {
			transport,
			sessionIds: fixture.sessionIds,
			scenarios: evidence,
		}
	} finally {
		await fixture.close()
	}
}

async function runScenario(
	fixture: Fixture,
	scenario: ScenarioName,
): Promise<ScenarioEvidence> {
	const eventStart = fixture.events.length
	const errorStart = fixture.errors.length
	const controller = new AbortController()
	const startedAt = performance.now()
	const promise = fixture.client.callTool(
		{ name: 'controlled', arguments: { scenario } },
		undefined,
		{ signal: controller.signal, timeout: 1_000 },
	)

	let settlement: Settlement
	if (scenario === 'complete-before-cancel') {
		settlement = await settle(promise, startedAt)
		controller.abort(new Error(abortReason))
	} else {
		await Bun.sleep(15)
		controller.abort(new Error(abortReason))
		settlement = await settle(promise, startedAt)
	}

	const reuseBeforeLate = await echo(fixture.client)
	await Bun.sleep(scenario === 'ignore' ? 110 : 35)
	const reuseAfterLate = await echo(fixture.client)

	return {
		scenario,
		settlement,
		reuseBeforeLate,
		reuseAfterLate,
		fixtureEvents: fixture.events.slice(eventStart),
		clientErrors: fixture.errors.slice(errorStart),
	}
}

async function settle(
	promise: Promise<unknown>,
	startedAt: number,
): Promise<Settlement> {
	try {
		const result = await promise
		return {
			status: 'fulfilled',
			elapsedMs: Math.round(performance.now() - startedAt),
			text: resultText(result),
		}
	} catch (error) {
		const value = error as Error & { code?: number }
		return {
			status: 'rejected',
			elapsedMs: Math.round(performance.now() - startedAt),
			error: {
				name: value.name,
				code: value.code,
				message: value.message,
			},
		}
	}
}

async function echo(client: Client): Promise<string> {
	const result = await client.callTool(
		{ name: 'echo', arguments: {} },
		undefined,
		{ timeout: 1_000 },
	)
	return resultText(result)
}

function resultText(result: unknown): string {
	if (!result || typeof result !== 'object' || !('content' in result))
		return JSON.stringify(result)
	const content = result.content
	if (!Array.isArray(content)) return JSON.stringify(result)
	const first = content[0]
	return first && typeof first === 'object' && 'text' in first
		? String(first.text)
		: JSON.stringify(result)
}

async function startStdioFixture(): Promise<Fixture> {
	const events: FixtureEvent[] = []
	const errors: string[] = []
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [path.join(prototypeDir, 'stdio-fixture.mjs')],
		stderr: 'pipe',
	})
	const client = new Client({
		name: 'cancellation-prototype',
		version: '1.0.0',
	})
	client.onerror = (error) => errors.push(error.message)
	await client.connect(transport)
	transport.stderr?.on('data', (chunk: Buffer) => {
		for (const line of chunk.toString('utf8').split('\n')) {
			if (!line) continue
			events.push(JSON.parse(line))
		}
	})
	return {
		client,
		events,
		errors,
		close: async () => {
			await client.close()
		},
	}
}

async function startHttpFixture(): Promise<Fixture> {
	const events: FixtureEvent[] = []
	const errors: string[] = []
	const sessionIds: Array<string | null> = []
	const pending = new Map<number | string, PendingHttpCall>()
	const completed = new Map<number | string, ScenarioName>()
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			if (request.method === 'GET') return new Response(null, { status: 405 })
			if (request.method !== 'POST') return new Response(null, { status: 405 })

			const message = (await request.json()) as {
				id?: number | string
				method: string
				params?: Record<string, any>
			}
			const sessionId = request.headers.get('mcp-session-id')
			sessionIds.push(sessionId)
			events.push({ event: 'message', method: message.method, id: message.id })

			if (message.method === 'initialize') {
				return jsonResponse(
					message.id,
					{
						protocolVersion: message.params?.protocolVersion,
						capabilities: { tools: {} },
						serverInfo: {
							name: 'cancellation-http-fixture',
							version: '1.0.0',
						},
					},
					{ 'mcp-session-id': 'local-session' },
				)
			}
			if (message.method === 'notifications/initialized') {
				return new Response(null, {
					status: 202,
					headers: { 'mcp-session-id': 'local-session' },
				})
			}
			if (message.method === 'notifications/cancelled') {
				const requestId = message.params?.requestId as number | string
				const entry = pending.get(requestId)
				events.push({
					event: 'cancel',
					requestId,
					reason: message.params?.reason,
					scenario: entry?.scenario ?? completed.get(requestId) ?? 'unknown',
					pending: Boolean(entry),
					originalRequestAborted: entry?.requestAborted ?? false,
				})
				if (entry?.scenario === 'acknowledge') {
					clearTimeout(entry.timer)
					pending.delete(requestId)
					entry.controller.close()
					events.push({
						event: 'work-stopped',
						requestId,
						scenario: entry.scenario,
					})
				}
				if (entry?.scenario === 'race') {
					clearTimeout(entry.timer)
					queueMicrotask(() =>
						completeHttpCall(entry, pending, completed, events),
					)
				}
				return new Response(null, {
					status: 202,
					headers: { 'mcp-session-id': 'local-session' },
				})
			}
			if (message.method !== 'tools/call')
				return new Response(null, { status: 202 })
			if (message.params?.name === 'echo') {
				return jsonResponse(message.id, toolResult('echo-ok'), {
					'mcp-session-id': 'local-session',
				})
			}

			const scenario = message.params?.arguments?.scenario as ScenarioName
			events.push({ event: 'call', id: message.id, scenario, sessionId })
			if (scenario === 'complete-before-cancel') {
				await Bun.sleep(5)
				completed.set(message.id!, scenario)
				events.push({ event: 'response', id: message.id, scenario })
				return jsonResponse(message.id, toolResult(scenario), {
					'mcp-session-id': 'local-session',
				})
			}

			let controller!: ReadableStreamDefaultController<Uint8Array>
			const stream = new ReadableStream<Uint8Array>({
				start(value) {
					controller = value
				},
			})
			const entry: PendingHttpCall = {
				id: message.id!,
				scenario,
				controller,
				requestAborted: request.signal.aborted,
			}
			request.signal.addEventListener('abort', () => {
				entry.requestAborted = true
				events.push({ event: 'request-aborted', id: entry.id, scenario })
			})
			pending.set(entry.id, entry)
			entry.timer = setTimeout(
				() => completeHttpCall(entry, pending, completed, events),
				scenario === 'ignore' ? 80 : 2_000,
			)
			return new Response(stream, {
				status: 200,
				headers: {
					'content-type': 'text/event-stream',
					'mcp-session-id': 'local-session',
				},
			})
		},
	})

	const transport = new StreamableHTTPClientTransport(
		new URL(`http://127.0.0.1:${server.port}/mcp`),
	)
	const client = new Client({
		name: 'cancellation-prototype',
		version: '1.0.0',
	})
	client.onerror = (error) => errors.push(error.message)
	await client.connect(transport)
	return {
		client,
		events,
		errors,
		sessionIds,
		close: async () => {
			await client.close()
			server.stop(true)
		},
	}
}

function completeHttpCall(
	entry: PendingHttpCall,
	pending: Map<number | string, PendingHttpCall>,
	completed: Map<number | string, ScenarioName>,
	events: FixtureEvent[],
): void {
	pending.delete(entry.id)
	completed.set(entry.id, entry.scenario)
	events.push({ event: 'response', id: entry.id, scenario: entry.scenario })
	entry.controller.enqueue(
		encoder.encode(
			`event: message\ndata: ${JSON.stringify({
				jsonrpc: '2.0',
				id: entry.id,
				result: toolResult(entry.scenario),
			})}\n\n`,
		),
	)
	entry.controller.close()
}

function toolResult(text: string): Record<string, unknown> {
	return { content: [{ type: 'text', text }] }
}

function jsonResponse(
	id: number | string | undefined,
	result: unknown,
	extraHeaders: Record<string, string> = {},
): Response {
	return Response.json(
		{ jsonrpc: '2.0', id, result },
		{ headers: extraHeaders },
	)
}

function summary(evidence: Evidence): Record<string, unknown> {
	return {
		runtime: evidence.runtime,
		transports: evidence.transports.map((transport) => ({
			transport: transport.transport,
			scenarios: transport.scenarios.map((scenario) => ({
				scenario: scenario.scenario,
				settlement: scenario.settlement,
				reuseBeforeLate: scenario.reuseBeforeLate,
				reuseAfterLate: scenario.reuseAfterLate,
				clientErrors: scenario.clientErrors,
			})),
		})),
	}
}

await main()
