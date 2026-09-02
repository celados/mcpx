import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { McpRuntime } from '../src/runtime'
import { RuntimeAuthentication } from '../src/runtime-authentication'
import { createInMemoryRuntimeCaller } from '../src/runtime-caller'
import { openRuntimeStores } from '../src/runtime-stores'

describe('Runtime explicit authentication', () => {
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
		expect(callers.every((caller) => caller.frames.length === 1)).toBe(true)
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
		expect(first.frames).toEqual([])
		expect(second.frames).toEqual([])
	})

	it('continues past a failed refresh and attributes the failure to its server', async () => {
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
				return {
					accessToken: 'rotated-access',
					refreshToken: 'rotated-refresh',
					clientId: 'working-client',
					tokenType: 'bearer',
					expiresAt: '2000-01-01T01:00:00.000Z',
				}
			},
		})
		const caller = createInMemoryRuntimeCaller('partial-refresh')

		const outcome = await authentication.refreshServers(undefined, caller)

		expect(outcome).toEqual({
			status: 'completed',
			refreshed: ['working'],
			failed: [
				{
					serverName: 'broken',
					message:
						'Failed to refresh broken: OAuth token refresh failed: invalid_grant',
				},
			],
		})
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
		const firstRun = authentication.refreshServers(['fixture'], first)
		const secondRun = authentication.refreshServers(['fixture'], second)
		await waitFor(() => firstPrompted)

		firstBase.disconnect()
		const outcomes = await Promise.all([firstRun, secondRun])

		expect(secondPrompted).toBe(true)
		expect(outcomes).toEqual([
			{ status: 'disconnected' },
			{ status: 'completed', refreshed: ['fixture'], failed: [] },
		])
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

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return
		await Bun.sleep(1)
	}
	throw new Error('Condition was not met.')
}
