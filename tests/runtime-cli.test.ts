import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const mainPath = path.join(import.meta.dir, '..', 'src', 'main.ts')
const fixtureServers: Bun.Server<unknown>[] = []
describe('Runtime CLI adapter lifecycle', () => {
	let home: string

	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-runtime-cli-'))
	})

	afterEach(async () => {
		await runCli(['@daemon', 'stop', '--raw']).catch(() => {})
		for (const server of fixtureServers.splice(0)) server.stop(true)
		await fs.rm(home, { recursive: true, force: true })
	})

	it('cancels the originating active Call when the CLI process exits and reuses the session', async () => {
		const fixture = startHttpFixture()
		await addFixture(fixture.url)

		const active = Array.from({ length: 5 }, () =>
			spawnCli([
				'controlled',
				'controlled',
				'--scenario',
				'acknowledge',
				'--raw',
			]),
		)
		await waitFor(async () => {
			const status = await runCli(['@daemon', 'status', '--raw'])
			if (status.exitCode !== 0) return false
			const session = JSON.parse(status.stdout).servers[0]
			return session?.activeCalls === 1 && session?.queuedCalls === 4
		})

		for (const child of active) child.kill()
		await Promise.all(active.map((child) => child.exited))
		await waitFor(async () => {
			const status = await runCli(['@daemon', 'status', '--raw'])
			return (
				status.exitCode === 0 &&
				JSON.parse(status.stdout).servers[0]?.activeCalls === 0
			)
		})

		const reused = await runCli(['controlled', 'echo', '--raw'])
		expect(reused).toEqual({
			exitCode: 0,
			stdout: 'echo-ok\n',
			stderr: '',
		})
	}, 10_000)

	it('exits five concurrent success and error CLIs without surviving PIDs', async () => {
		const fixture = startHttpFixture()
		await addFixture(fixture.url)
		const successes = Array.from({ length: 5 }, () =>
			spawnObserved(['controlled', 'echo', '--raw']),
		)
		const successResults = await Promise.all(successes.map(waitForExit))
		expect(successResults).toEqual(
			Array.from({ length: 5 }, () => ({
				exitCode: 0,
				stdout: 'echo-ok\n',
				stderr: '',
			})),
		)
		for (const child of successes) expect(isAlive(child.pid)).toBe(false)

		const failures = Array.from({ length: 5 }, () =>
			spawnObserved(['controlled', 'fail', '--raw']),
		)
		const failureResults = await Promise.all(failures.map(waitForExit))
		expect(failureResults.every((result) => result.exitCode === 1)).toBe(true)
		expect(
			failureResults.every((result) =>
				result.stderr.includes('fixture failure'),
			),
		).toBe(true)
		for (const child of failures) expect(isAlive(child.pid)).toBe(false)
	}, 10_000)

	it('treats a closed stdout pipe as a bounded terminal path', async () => {
		const fixture = startHttpFixture()
		await addFixture(fixture.url)
		const children = Array.from({ length: 5 }, () =>
			spawnCli(['controlled', 'echo', '--raw']),
		)
		await Promise.all(children.map((child) => child.stdout.cancel()))
		const exitCodes = await Promise.all(
			children.map((child) =>
				Promise.race([child.exited, Bun.sleep(3_000).then(() => undefined)]),
			),
		)
		expect(exitCodes.every((code) => code !== undefined)).toBe(true)
		for (const child of children) expect(isAlive(child.pid)).toBe(false)
	}, 10_000)

	it('single-flights five explicit refresh CLI processes through one local token request', async () => {
		const fixture = startHttpFixture()
		await seedExpiredOAuth(fixture.url, fixture.issuer)
		const refreshes = Array.from({ length: 5 }, () =>
			spawnObserved(['@refresh', '--raw']),
		)
		const results = await Promise.all(refreshes.map(waitForExit))

		expect(results.every((result) => result.exitCode === 0)).toBe(true)
		expect(fixture.tokenRequests()).toBe(1)
		for (const child of refreshes) expect(isAlive(child.pid)).toBe(false)
	}, 10_000)

	it('cancels an active refresh flow before Runtime stop completes', async () => {
		const fixture = startHttpFixture({ holdToken: true })
		await seedExpiredOAuth(fixture.url, fixture.issuer)
		const refresh = spawnObserved(['@refresh', '--raw'])
		await waitFor(async () => fixture.tokenRequests() === 1)

		const stopped = await runCli(['@daemon', 'stop', '--raw'])
		const refreshResult = await waitForExit(refresh)

		expect(stopped.exitCode).toBe(0)
		expect(refreshResult.exitCode).toBe(1)
		expect(isAlive(refresh.pid)).toBe(false)
	}, 10_000)

	async function addFixture(url: string): Promise<void> {
		const added = await runCli([
			'@add',
			'--name',
			'controlled',
			'--url',
			url,
			'--raw',
		])
		expect(added.exitCode).toBe(0)
	}

	async function seedExpiredOAuth(url: string, issuer: string): Promise<void> {
		const root = path.join(home, '.agents', 'mcpx')
		await fs.mkdir(root, { recursive: true })
		const tokenKey = `controlled:${issuer}`
		await fs.writeFile(
			path.join(root, 'servers.json'),
			JSON.stringify({
				version: 1,
				servers: {
					controlled: {
						url,
						auth: { kind: 'oauth-token', tokenKey, confidence: 'confirmed' },
					},
				},
			}),
		)
		await fs.writeFile(
			path.join(root, 'tokens.json'),
			JSON.stringify({
				version: 1,
				oauth: {
					[tokenKey]: {
						accessToken: 'expired',
						refreshToken: 'local-refresh',
						clientId: 'local-client',
						tokenType: 'bearer',
						expiresAt: '2000-01-01T00:00:00.000Z',
					},
				},
			}),
		)
	}

	function spawnCli(args: string[]) {
		return Bun.spawn([process.execPath, mainPath, ...args], {
			env: { ...process.env, HOME: home, MCPX_HOME: home },
			stdout: 'pipe',
			stderr: 'pipe',
		})
	}

	function spawnObserved(args: string[]) {
		const proc = spawnCli(args)
		return {
			proc,
			pid: proc.pid,
			stdout: new Response(proc.stdout).text(),
			stderr: new Response(proc.stderr).text(),
		}
	}

	async function waitForExit(child: ReturnType<typeof spawnObserved>) {
		const exitCode = await Promise.race([
			child.proc.exited,
			Bun.sleep(3_000).then(() => undefined),
		])
		if (exitCode === undefined) {
			child.proc.kill()
			throw new Error(`CLI ${child.pid} did not exit before the deadline.`)
		}
		return {
			exitCode,
			stdout: await child.stdout,
			stderr: await child.stderr,
		}
	}

	async function runCli(args: string[]): Promise<{
		exitCode: number
		stdout: string
		stderr: string
	}> {
		const proc = spawnCli(args)
		const stdout = new Response(proc.stdout).text()
		const stderr = new Response(proc.stderr).text()
		return {
			exitCode: await proc.exited,
			stdout: await stdout,
			stderr: await stderr,
		}
	}
})

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH'
	}
}

function startHttpFixture(options: { holdToken?: boolean } = {}): {
	url: string
	issuer: string
	tokenRequests: () => number
} {
	let tokenRequests = 0
	let issuer = ''
	const pending = new Map<string | number, (response: Response) => void>()
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const requestUrl = new URL(request.url)
			if (requestUrl.pathname === '/.well-known/oauth-authorization-server') {
				return Response.json({
					issuer,
					authorization_endpoint: `${issuer}/authorize`,
					token_endpoint: `${issuer}/token`,
				})
			}
			if (requestUrl.pathname === '/token') {
				tokenRequests += 1
				if (options.holdToken) await new Promise(() => {})
				await Bun.sleep(25)
				return Response.json({
					access_token: 'local-access',
					refresh_token: 'local-refresh-2',
					token_type: 'bearer',
					expires_in: 3600,
				})
			}
			if (requestUrl.pathname !== '/mcp' || request.method !== 'POST') {
				return new Response(null, { status: 404 })
			}
			const message = (await request.json()) as {
				id?: string | number
				method: string
				params?: Record<string, any>
			}
			if (message.method === 'initialize') {
				return rpcResponse(message.id, {
					protocolVersion: message.params?.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: 'local-cli-fixture', version: '1.0.0' },
				})
			}
			if (message.method === 'notifications/initialized')
				return acceptedResponse()
			if (message.method === 'tools/list') {
				return rpcResponse(message.id, {
					tools: [
						{ name: 'echo', inputSchema: { type: 'object' } },
						{ name: 'fail', inputSchema: { type: 'object' } },
						{
							name: 'controlled',
							inputSchema: {
								type: 'object',
								properties: { scenario: { type: 'string' } },
								required: ['scenario'],
							},
						},
					],
				})
			}
			if (message.method === 'notifications/cancelled') {
				const id = message.params?.requestId as string | number
				pending.get(id)?.(rpcResponse(id, toolResult('cancelled')))
				pending.delete(id)
				return acceptedResponse()
			}
			if (message.method !== 'tools/call') return acceptedResponse()
			if (message.params?.name === 'echo')
				return rpcResponse(message.id, toolResult('echo-ok'))
			if (message.params?.name === 'fail') {
				return rpcError(message.id, -32_000, 'fixture failure')
			}
			return new Promise<Response>((resolve) => {
				if (message.id !== undefined) pending.set(message.id, resolve)
			})
		},
	})
	fixtureServers.push(server)
	issuer = `http://127.0.0.1:${server.port}`
	return {
		url: `${issuer}/mcp`,
		issuer,
		tokenRequests: () => tokenRequests,
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

function rpcError(id: unknown, code: number, message: string): Response {
	return Response.json(
		{ jsonrpc: '2.0', id, error: { code, message } },
		{ headers: { 'mcp-session-id': 'local-session' } },
	)
}

function toolResult(text: string): Record<string, unknown> {
	return { content: [{ type: 'text', text }] }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await predicate()) return
		await Bun.sleep(20)
	}
	throw new Error('Condition was not met.')
}
