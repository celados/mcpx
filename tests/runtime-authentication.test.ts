import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { McpConnection } from '../src/mcp-client'
import type { RuntimeFrame } from '../src/runtime-protocol'
import type { RuntimeStores } from '../src/runtime-stores'

import { McpRuntime } from '../src/runtime'
import { RuntimeAuthentication } from '../src/runtime-authentication'
import { createInMemoryRuntimeCaller } from '../src/runtime-caller'
import { RuntimeSessionPool } from '../src/runtime-session-pool'
import { openRuntimeStores } from '../src/runtime-stores'

describe('Runtime authentication', () => {
	const roots: string[] = []
	const servers: Bun.Server<unknown>[] = []

	afterEach(async () => {
		for (const server of servers.splice(0)) server.stop(true)
		await Promise.all(
			roots.splice(0).map((root) => fs.rm(root, { recursive: true })),
		)
	})

	it('single-flights five explicit refresh callers through one local token request', async () => {
		let refreshRequests = 0
		let issuer = ''
		const fixture = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			async fetch(request): Promise<Response> {
				if (request.url.endsWith('/.well-known/oauth-authorization-server')) {
					return Response.json({
						issuer,
						authorization_endpoint: `${issuer}/authorize`,
						token_endpoint: `${issuer}/token`,
					})
				}
				if (request.url.endsWith('/token')) {
					refreshRequests += 1
					await Bun.sleep(20)
					return Response.json({
						access_token: 'rotated-access',
						refresh_token: 'rotated-refresh',
						token_type: 'bearer',
						expires_in: 3600,
					})
				}
				return new Response(null, { status: 404 })
			},
		})
		servers.push(fixture)
		issuer = `http://127.0.0.1:${fixture.port}`
		const tokenKey = `fixture:${issuer}`
		const stores = await createStores(
			{
				url: `${issuer}/mcp`,
				auth: { kind: 'oauth-token', tokenKey, confidence: 'confirmed' },
			},
			{
				[tokenKey]: {
					accessToken: 'expired',
					refreshToken: 'refresh-1',
					clientId: 'fixture-client',
					tokenType: 'bearer',
					expiresAt: '2000-01-01T00:00:00.000Z',
				},
			},
		)
		const runtime = new McpRuntime(stores)
		const callers = Array.from({ length: 5 }, (_, index) =>
			createInMemoryRuntimeCaller(`refresh-${index}`),
		)

		await Promise.all(
			callers.map((caller) =>
				runtime.handle(
					{
						requestId: caller.id,
						op: 'refreshServers',
						serverNames: ['fixture'],
					},
					caller,
				),
			),
		)

		expect(refreshRequests).toBe(1)
		expect((await stores.credentials.read()).oauth[tokenKey]?.accessToken).toBe(
			'rotated-access',
		)
		expect(callers.every((caller) => terminalFrames(caller).length === 1)).toBe(
			true,
		)
	})

	it('keeps an interactive flow for remaining waiters and aborts after the final disconnect', async () => {
		const stores = await createStores({
			url: 'http://127.0.0.1:1/mcp',
			auth: {
				kind: 'oauth',
				confidence: 'confirmed',
				authorizationServers: ['http://127.0.0.1:1'],
			},
		})
		let signal: AbortSignal | undefined
		let callbackOpen = false
		let starts = 0
		const authentication = new RuntimeAuthentication(stores, {
			authenticate: async (_name, _url, _auth, flowSignal) => {
				starts += 1
				signal = flowSignal
				callbackOpen = true
				return new Promise((_resolve, reject) => {
					flowSignal?.addEventListener(
						'abort',
						() => {
							callbackOpen = false
							reject(flowSignal.reason)
						},
						{ once: true },
					)
				})
			},
		})
		const runtime = new McpRuntime(stores, { authentication })
		const first = createInMemoryRuntimeCaller('first')
		const secondBase = createInMemoryRuntimeCaller('second')
		let secondJoined = false
		const second = {
			...secondBase,
			onDisconnect: (listener: () => void) => {
				// Opening the callback only proves the first waiter joined; wait for the
				// second subscription so slower CI runners cannot disconnect too early.
				secondJoined = true
				return secondBase.onDisconnect(listener)
			},
		}
		const firstRun = runtime.handle(
			{ requestId: 'first', op: 'refreshServers', serverNames: ['fixture'] },
			first,
		)
		const secondRun = runtime.handle(
			{ requestId: 'second', op: 'refreshServers', serverNames: ['fixture'] },
			second,
		)
		await waitFor(() => callbackOpen && secondJoined)

		first.disconnect()
		expect(signal?.aborted).toBe(false)
		second.disconnect()
		await Promise.all([firstRun, secondRun])

		expect(starts).toBe(1)
		expect(callbackOpen).toBe(false)
		expect(terminalFrames(first)).toEqual([])
		expect(terminalFrames(second)).toEqual([])
	})

	it('continues past a failed server and attributes the failure to it', async () => {
		const stores = await createStores(
			{
				url: 'http://127.0.0.1:1/broken/mcp',
				auth: {
					kind: 'oauth-token',
					tokenKey: 'broken:http://127.0.0.1:1',
					confidence: 'confirmed',
				},
			},
			{
				'broken:http://127.0.0.1:1': {
					accessToken: 'broken-access',
					refreshToken: 'broken-refresh',
					clientId: 'broken-client',
					tokenType: 'bearer',
					expiresAt: '2000-01-01T00:00:00.000Z',
				},
			},
			'broken',
		)
		await stores.upsertServer('working', {
			url: 'http://127.0.0.1:1/working/mcp',
			auth: {
				kind: 'oauth-token',
				tokenKey: 'working:http://127.0.0.1:1',
				confidence: 'confirmed',
			},
		})
		await stores.updateState((state) => {
			state.credentials.oauth['working:http://127.0.0.1:1'] = {
				accessToken: 'working-access',
				refreshToken: 'working-refresh',
				clientId: 'working-client',
				tokenType: 'bearer',
				expiresAt: '2000-01-01T00:00:00.000Z',
			}
		})
		const authentication = new RuntimeAuthentication(stores, {
			refreshToken: async ({ resourceUrl }) => {
				if (resourceUrl.includes('/broken/'))
					throw new Error('OAuth token refresh failed: invalid_grant')
				return freshToken('rotated-access', 'working-client')
			},
			authenticate: async () => {
				throw new Error('browser authorization failed')
			},
		})
		const runtime = runtimeWith(stores, authentication, async () => [
			{ name: 'echo' },
		])
		const caller = createInMemoryRuntimeCaller('partial-refresh')

		await runtime.handle(
			{ requestId: 'partial-refresh', op: 'refreshServers' },
			caller,
		)

		expect(terminalFrames(caller)).toEqual([
			{
				requestId: 'partial-refresh',
				kind: 'result',
				result: {
					status: 'completed',
					refreshed: ['working'],
					failed: [
						{
							serverName: 'broken',
							message:
								'Credentials for broken must be refreshed: browser authorization failed',
						},
					],
				},
			},
		])
		const messages = progressMessages(caller)
		expect(messages).toContain('broken: refreshing OAuth token')
		expect(messages).toContain(
			'broken: token refresh failed (OAuth token refresh failed: invalid_grant); starting browser authorization',
		)
		expect(messages).toContain('working: ok (1 tool)')
		const state = await stores.readState()
		expect(state.schemas.servers.broken?.refreshStatus).toMatchObject({
			status: 'reauth-required',
		})
		expect(state.schemas.servers.working?.refreshStatus).toMatchObject({
			status: 'ok',
		})
	})

	it('silently refreshes an expiring token before an ordinary Call', async () => {
		const stores = await createStores(oauthTokenServer(), {
			[TOKEN_KEY]: expiredToken(),
		})
		let refreshes = 0
		const authorizations: (string | undefined)[] = []
		const authentication = new RuntimeAuthentication(stores, {
			refreshToken: async () => {
				refreshes += 1
				return freshToken('rotated-access')
			},
			authenticate: async () => {
				throw new Error('must not open a browser')
			},
		})
		const runtime = runtimeWith(stores, authentication, undefined, {
			onConnect: (headers) => authorizations.push(headers?.Authorization),
		})
		const caller = createInMemoryRuntimeCaller('call')

		await runtime.handle(callIntent('call'), caller)

		expect(refreshes).toBe(1)
		expect(authorizations).toEqual(['Bearer rotated-access'])
		expect(terminalFrames(caller)[0]).toMatchObject({ kind: 'result' })
		expect(progressMessages(caller)).toEqual([
			'fixture: refreshing OAuth token',
		])
	})

	it('replaces a rejected credential and retries the Call once', async () => {
		const stores = await createStores(oauthTokenServer(), {
			[TOKEN_KEY]: freshToken('revoked-access'),
		})
		let refreshes = 0
		const authentication = new RuntimeAuthentication(stores, {
			refreshToken: async () => {
				refreshes += 1
				return freshToken('rotated-access')
			},
		})
		const attempts: (string | undefined)[] = []
		const runtime = runtimeWith(stores, authentication, undefined, {
			onConnect: (headers) => attempts.push(headers?.Authorization),
			callTool: async (headers) => {
				if (headers?.Authorization === 'Bearer revoked-access')
					throw Object.assign(new Error('Unauthorized'), { code: 401 })
				return 'ok'
			},
		})
		const caller = createInMemoryRuntimeCaller('call')

		await runtime.handle(callIntent('call'), caller)

		expect(refreshes).toBe(1)
		expect(attempts).toEqual(['Bearer revoked-access', 'Bearer rotated-access'])
		expect(terminalFrames(caller)).toEqual([
			{
				requestId: 'call',
				kind: 'result',
				result: { result: 'ok', notifications: [], toolsChanged: false },
			},
		])
	})

	it('holds a Call until browser authorization completes and reports the URL', async () => {
		const stores = await createStores({
			url: 'http://127.0.0.1:1/mcp',
			auth: {
				kind: 'oauth',
				confidence: 'confirmed',
				authorizationServers: ['http://127.0.0.1:1'],
			},
		})
		let approve = () => {}
		const authentication = new RuntimeAuthentication(stores, {
			authenticate: async (_name, _url, _auth, _signal, _manual, onUrl) => {
				onUrl?.('http://127.0.0.1:1/authorize?state=fixture')
				await new Promise<void>((resolve) => {
					approve = resolve
				})
				return {
					auth: {
						kind: 'oauth-token',
						tokenKey: TOKEN_KEY,
						confidence: 'confirmed',
					},
					token: freshToken('browser-access'),
				}
			},
		})
		const authorizations: (string | undefined)[] = []
		const runtime = runtimeWith(stores, authentication, undefined, {
			onConnect: (headers) => authorizations.push(headers?.Authorization),
		})
		const first = createInMemoryRuntimeCaller('first')
		const late = createInMemoryRuntimeCaller('late')

		const firstRun = runtime.handle(callIntent('first'), first)
		await waitFor(() => progressMessages(first).length > 0)
		const lateRun = runtime.handle(callIntent('late'), late)
		await waitFor(() => progressMessages(late).length > 0)
		expect(terminalFrames(first)).toEqual([])
		approve()
		await Promise.all([firstRun, lateRun])

		const expected =
			'fixture: authorize in your browser (waiting up to 5 minutes): http://127.0.0.1:1/authorize?state=fixture'
		// The late Call joined after the URL was issued and still receives it.
		expect(progressMessages(first)).toEqual([expected])
		expect(progressMessages(late)).toEqual([expected])
		expect(terminalFrames(first)[0]).toMatchObject({ kind: 'result' })
		expect(terminalFrames(late)[0]).toMatchObject({ kind: 'result' })
		expect(authorizations).toEqual(['Bearer browser-access'])
		expect((await stores.readState()).registry.servers.fixture).toMatchObject({
			auth: { kind: 'oauth-token', tokenKey: TOKEN_KEY },
		})
	})

	it('fails fast when manual OAuth client input has no terminal', async () => {
		const stores = await createStores({
			url: 'http://127.0.0.1:1/mcp',
			auth: {
				kind: 'oauth',
				confidence: 'confirmed',
				authorizationServers: ['http://127.0.0.1:1'],
			},
		})
		const authentication = new RuntimeAuthentication(stores, {
			authenticate: async (_name, _url, _auth, _signal, manualClient) => {
				await manualClient?.({
					serverName: 'fixture',
					redirectUri: 'http://127.0.0.1:65245/callback',
					issuer: 'http://127.0.0.1:1',
					scopes: [],
				})
				throw new Error('unreachable')
			},
		})
		const runtime = runtimeWith(stores, authentication)
		const caller = {
			...createInMemoryRuntimeCaller('agent'),
			requestInput: async () => ({
				cancelled: true,
				reason: 'Interactive terminal required.',
			}),
		}

		await runtime.handle(callIntent('agent'), caller)

		expect(terminalFrames(caller)).toEqual([
			{
				requestId: 'agent',
				kind: 'error',
				error: {
					code: 'reauth-required',
					message:
						'Credentials for fixture must be refreshed: OAuth client credentials must be entered interactively (Interactive terminal required.). Run mcpx @refresh in a terminal',
				},
			},
		])
	})

	it('requests manual OAuth client input from the CLI caller and persists it in Runtime state', async () => {
		const stores = await createStores({
			url: 'http://127.0.0.1:1/mcp',
			auth: {
				kind: 'oauth',
				confidence: 'confirmed',
				authorizationServers: ['http://127.0.0.1:1'],
			},
		})
		let inputRequests = 0
		const authentication = new RuntimeAuthentication(stores, {
			authenticate: async (_name, _url, _auth, _signal, manualClient) => {
				const client = await manualClient?.({
					serverName: 'fixture',
					redirectUri: 'http://127.0.0.1:65245/callback',
					issuer: 'http://127.0.0.1:1',
					scopes: ['scope:read'],
				})
				if (!client) throw new Error('Missing manual client.')
				return {
					auth: {
						kind: 'oauth-token',
						tokenKey: 'fixture:issuer',
						confidence: 'confirmed',
					},
					token: {
						accessToken: 'local-access',
						tokenType: 'bearer',
						clientId: client.clientId,
						clientSecretKey: client.clientSecretKey,
					},
					clientSecret: client.clientSecret,
				}
			},
		})
		const runtime = new McpRuntime(stores, { authentication })
		const caller = {
			...createInMemoryRuntimeCaller('manual'),
			requestInput: async (request: { type: string }) => {
				inputRequests += 1
				expect(request.type).toBe('oauth-client')
				return { clientId: 'local-client', clientSecret: 'local-secret' }
			},
		}

		await runtime.handle(
			{ requestId: 'manual', op: 'refreshServers', serverNames: ['fixture'] },
			caller,
		)

		expect(inputRequests).toBe(1)
		const state = await stores.readState()
		expect(state.credentials.oauth['fixture:issuer']?.clientId).toBe(
			'local-client',
		)
		expect(
			state.credentials.oauthClientSecrets['oauth-client:local-client'],
		).toBe('local-secret')
		expect(state.registry.servers.fixture).toMatchObject({
			auth: { kind: 'oauth-token' },
		})
	})

	it('moves manual OAuth input to a surviving waiter after the first caller disconnects', async () => {
		const stores = await createStores({
			url: 'http://127.0.0.1:1/mcp',
			auth: {
				kind: 'oauth',
				confidence: 'confirmed',
				authorizationServers: ['http://127.0.0.1:1'],
			},
		})
		let firstPrompted = false
		let secondPrompted = false
		const authentication = new RuntimeAuthentication(stores, {
			authenticate: async (_name, _url, _auth, _signal, manualClient) => {
				const client = await manualClient?.({
					serverName: 'fixture',
					redirectUri: 'http://127.0.0.1:65245/callback',
					issuer: 'http://127.0.0.1:1',
					scopes: [],
				})
				if (!client) throw new Error('Missing manual client.')
				return {
					auth: {
						kind: 'oauth-token',
						tokenKey: 'fixture:issuer',
						confidence: 'confirmed',
					},
					token: {
						accessToken: 'local-access',
						tokenType: 'bearer',
						clientId: client.clientId,
					},
				}
			},
		})
		const firstBase = createInMemoryRuntimeCaller('first-input')
		const first = {
			...firstBase,
			requestInput: () => {
				firstPrompted = true
				return new Promise<unknown>((_resolve, reject) => {
					firstBase.onDisconnect(() => reject(new Error('caller disconnected')))
				})
			},
		}
		const second = {
			...createInMemoryRuntimeCaller('second-input'),
			requestInput: async () => {
				secondPrompted = true
				return { clientId: 'survivor', clientSecret: 'local-secret' }
			},
		}
		const firstRun = authentication.authorize('fixture', first)
		const secondRun = authentication.authorize('fixture', second)
		await waitFor(() => firstPrompted)

		firstBase.disconnect()
		const outcomes = await Promise.all([firstRun, secondRun])

		expect(secondPrompted).toBe(true)
		expect(outcomes).toEqual(['disconnected', 'ready'])
	})

	async function createStores(
		server: Record<string, unknown>,
		oauth: Record<string, unknown> = {},
		name = 'fixture',
	) {
		const root = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-runtime-auth-'))
		roots.push(root)
		await fs.writeFile(
			path.join(root, 'servers.json'),
			JSON.stringify({ version: 1, servers: { [name]: server } }),
		)
		await fs.writeFile(
			path.join(root, 'tokens.json'),
			JSON.stringify({ version: 1, oauth, oauthClientSecrets: {} }),
		)
		return openRuntimeStores(root)
	}
})

const TOKEN_KEY = 'fixture:http://127.0.0.1:1'

function oauthTokenServer() {
	return {
		url: 'http://127.0.0.1:1/mcp',
		auth: { kind: 'oauth-token', tokenKey: TOKEN_KEY, confidence: 'confirmed' },
	}
}

function expiredToken() {
	return {
		accessToken: 'expired-access',
		refreshToken: 'refresh-1',
		clientId: 'fixture-client',
		tokenType: 'bearer',
		expiresAt: '2000-01-01T00:00:00.000Z',
	}
}

function freshToken(accessToken: string, clientId = 'fixture-client') {
	return {
		accessToken,
		refreshToken: 'refresh-2',
		clientId,
		tokenType: 'bearer',
		expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
	}
}

function callIntent(requestId: string) {
	return {
		requestId,
		op: 'call' as const,
		serverName: 'fixture',
		toolName: 'echo',
		input: {},
	}
}

function runtimeWith(
	stores: RuntimeStores,
	authentication: RuntimeAuthentication,
	listTools: () => Promise<unknown[]> = async () => [],
	options: {
		onConnect?: (headers: Record<string, string> | undefined) => void
		callTool?: (headers: Record<string, string> | undefined) => Promise<unknown>
	} = {},
): McpRuntime {
	const sessions = new RuntimeSessionPool(stores, {
		authentication,
		connect: async (_server, connectOptions) => {
			const headers = connectOptions?.headers
			options.onConnect?.(headers)
			const connection: McpConnection = {
				client: {
					callTool: async () =>
						(options.callTool ?? (async () => 'ok'))(headers),
					listTools: async () => ({ tools: await listTools() }),
				} as unknown as McpConnection['client'],
				close: async () => {},
				pid: () => null,
				stderr: null,
				sessionId: () => undefined,
				updateHeaders: () => {},
			}
			return connection
		},
	})
	return new McpRuntime(stores, { authentication, sessions })
}

function terminalFrames(caller: { frames: RuntimeFrame[] }): RuntimeFrame[] {
	return caller.frames.filter((frame) => frame.kind !== 'event')
}

function progressMessages(caller: { frames: RuntimeFrame[] }): string[] {
	return caller.frames.flatMap((frame) =>
		frame.kind === 'event' &&
		frame.event.type === 'progress' &&
		!/: (checking credentials|listing tools)$/.test(frame.event.message ?? '')
			? [frame.event.message ?? '']
			: [],
	)
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return
		await Bun.sleep(1)
	}
	throw new Error('Condition was not met.')
}
