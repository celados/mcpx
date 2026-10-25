import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { McpConnection } from '../src/mcp-client'
import type { AuthorizeOAuthOptions, OAuthGrant } from '../src/oauth'
import type { RuntimeFrame } from '../src/runtime-protocol'
import type { DeclaredServer, RuntimeStores } from '../src/runtime-stores'

import { AuthorizationChallengeError } from '../src/mcp-client'
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
						response_types_supported: ['code'],
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
		const stores = await createStores(
			{ fixture: { url: `${issuer}/mcp`, auth: { kind: 'oauth' } } },
			{ fixture: expiredGrant() },
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
		expect(
			(await stores.credentials.read()).oauth.fixture?.tokens?.value
				.access_token,
		).toBe('rotated-access')
		expect(callers.every((caller) => terminalFrames(caller).length === 1)).toBe(
			true,
		)
	})

	it('keeps an interactive flow for remaining waiters and aborts after the final disconnect', async () => {
		const stores = await createStores({ fixture: oauthServer() })
		let signal: AbortSignal | undefined
		let callbackOpen = false
		let starts = 0
		const authentication = new RuntimeAuthentication(stores, {
			authorizeOAuth: async ({ signal: flowSignal }) => {
				starts += 1
				signal = flowSignal
				callbackOpen = true
				return new Promise((_resolve, reject) => {
					flowSignal.addEventListener(
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
				broken: oauthServer('http://127.0.0.1:1/broken/mcp'),
				working: oauthServer('http://127.0.0.1:1/working/mcp'),
			},
			{ broken: expiredGrant(), working: expiredGrant() },
		)
		const authentication = new RuntimeAuthentication(stores, {
			authorizeOAuth: async ({ serverName, grants, report }) => {
				report({ phase: 'refreshing-token', message: 'refreshing OAuth token' })
				if (serverName === 'broken')
					throw new Error('browser authorization failed')
				await grants.update(() => freshGrant('rotated-access'))
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
		const stores = await createStores(
			{ fixture: oauthServer() },
			{ fixture: expiredGrant() },
		)
		let refreshes = 0
		const authentication = new RuntimeAuthentication(stores, {
			authorizeOAuth: async ({ grants, report, challenge }) => {
				expect(challenge).toBeUndefined()
				refreshes += 1
				report({ phase: 'refreshing-token', message: 'refreshing OAuth token' })
				await grants.update(() => freshGrant('rotated-access'))
			},
		})
		const tokens: (string | undefined)[] = []
		const runtime = runtimeWith(stores, authentication, undefined, {
			onConnect: (token) => tokens.push(token),
		})
		const caller = createInMemoryRuntimeCaller('call')

		await runtime.handle(callIntent('call'), caller)

		expect(refreshes).toBe(1)
		expect(tokens).toEqual(['rotated-access'])
		expect(terminalFrames(caller)[0]).toMatchObject({ kind: 'result' })
		expect(progressMessages(caller)).toEqual([
			'fixture: refreshing OAuth token',
		])
	})

	it('replaces a rejected credential and retries the Call once', async () => {
		const stores = await createStores(
			{ fixture: oauthServer() },
			{ fixture: freshGrant('revoked-access') },
		)
		const challenges: unknown[] = []
		const authentication = new RuntimeAuthentication(stores, {
			authorizeOAuth: async ({ grants, challenge }) => {
				challenges.push(challenge)
				await grants.update(() => freshGrant('rotated-access'))
			},
		})
		const attempts: (string | undefined)[] = []
		const runtime = runtimeWith(stores, authentication, undefined, {
			onConnect: (token) => attempts.push(token),
			callTool: async (token) => {
				if (token === 'revoked-access')
					throw new AuthorizationChallengeError({ status: 401 })
				return 'ok'
			},
		})
		const caller = createInMemoryRuntimeCaller('call')

		await runtime.handle(callIntent('call'), caller)

		expect(challenges).toEqual([{ status: 401 }])
		expect(attempts).toEqual(['revoked-access', 'rotated-access'])
		expect(terminalFrames(caller)).toEqual([
			{
				requestId: 'call',
				kind: 'result',
				result: { result: 'ok', notifications: [], toolsChanged: false },
			},
		])
	})

	it('discovers OAuth from a 401 challenge on a server declared without auth', async () => {
		const stores = await createStores({
			fixture: { url: 'http://127.0.0.1:1/mcp', auth: { kind: 'none' } },
		})
		const challenge = {
			status: 401 as const,
			resourceMetadataUrl:
				'http://127.0.0.1:1/.well-known/oauth-protected-resource/mcp',
			scope: 'mcp:tools',
		}
		const seen: AuthorizeOAuthOptions['challenge'][] = []
		const authentication = new RuntimeAuthentication(stores, {
			authorizeOAuth: async (options) => {
				seen.push(options.challenge)
				options.report({
					phase: 'awaiting-browser',
					message: 'authorize in your browser: http://127.0.0.1:1/authorize',
					url: 'http://127.0.0.1:1/authorize',
				})
				await options.grants.update(() => freshGrant('browser-access'))
			},
		})
		const attempts: (string | undefined)[] = []
		const runtime = runtimeWith(stores, authentication, undefined, {
			onConnect: (token) => attempts.push(token),
			callTool: async (token) => {
				if (!token) throw new AuthorizationChallengeError(challenge)
				return 'status'
			},
		})
		const caller = createInMemoryRuntimeCaller('call')

		await runtime.handle(callIntent('call'), caller)

		expect(seen).toEqual([challenge])
		expect(attempts).toEqual([undefined, 'browser-access'])
		expect(terminalFrames(caller)[0]).toMatchObject({
			kind: 'result',
			result: { result: 'status' },
		})
		expect(progressMessages(caller)).toEqual([
			'fixture: authorize in your browser: http://127.0.0.1:1/authorize',
		])
		expect((await stores.registry.read()).servers.fixture).toMatchObject({
			auth: { kind: 'oauth' },
		})
	})

	it('reports reauth-required when a bearer credential is challenged', async () => {
		const stores = await createStores({
			fixture: {
				url: 'http://127.0.0.1:1/mcp',
				auth: {
					kind: 'bearer',
					strategy: 'round-robin',
					confidence: 'configured',
					credentials: [{ kind: 'stored', key: 'fixture:bearer:0' }],
				},
			},
		})
		await stores.updateState((state) => {
			state.credentials.bearer['fixture:bearer:0'] = 'static'
		})
		const authentication = new RuntimeAuthentication(stores, {
			authorizeOAuth: async () => {
				throw new Error('must not start OAuth')
			},
		})
		const runtime = runtimeWith(stores, authentication, undefined, {
			callTool: async () => {
				throw new AuthorizationChallengeError({ status: 401 })
			},
		})
		const caller = createInMemoryRuntimeCaller('call')

		await runtime.handle(callIntent('call'), caller)

		expect(terminalFrames(caller)[0]).toMatchObject({
			kind: 'error',
			error: { code: 'reauth-required' },
		})
	})

	it('holds a Call until browser authorization completes and reports the URL', async () => {
		const stores = await createStores({ fixture: oauthServer() })
		let approve = () => {}
		const authentication = new RuntimeAuthentication(stores, {
			authorizeOAuth: async ({ grants, report }) => {
				report({
					phase: 'awaiting-browser',
					message:
						'authorize in your browser (waiting up to 5 minutes): http://127.0.0.1:1/authorize?state=fixture',
					url: 'http://127.0.0.1:1/authorize?state=fixture',
				})
				await new Promise<void>((resolve) => {
					approve = resolve
				})
				await grants.update(() => freshGrant('browser-access'))
			},
		})
		const tokens: (string | undefined)[] = []
		const runtime = runtimeWith(stores, authentication, undefined, {
			onConnect: (token) => tokens.push(token),
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
		expect(tokens).toEqual(['browser-access'])
	})

	it('fails fast when manual OAuth client input has no terminal', async () => {
		const stores = await createStores({ fixture: oauthServer() })
		const authentication = new RuntimeAuthentication(stores, {
			authorizeOAuth: async ({ requestManualClient }) => {
				await requestManualClient(manualRequest())
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

	it('requests manual OAuth client input from the CLI caller', async () => {
		const stores = await createStores({ fixture: oauthServer() })
		const requests: unknown[] = []
		const authentication = new RuntimeAuthentication(stores, {
			authorizeOAuth: async ({ requestManualClient, grants }) => {
				const client = await requestManualClient(manualRequest())
				expect(client).toEqual({
					clientId: 'local-client',
					clientSecret: 'local-secret',
				})
				await grants.update(() => freshGrant('local-access'))
			},
		})
		const runtime = new McpRuntime(stores, { authentication })
		const caller = {
			...createInMemoryRuntimeCaller('manual'),
			requestInput: async (request: unknown) => {
				requests.push(request)
				return { clientId: ' local-client ', clientSecret: 'local-secret' }
			},
		}

		await runtime.handle(
			{ requestId: 'manual', op: 'refreshServers', serverNames: ['fixture'] },
			caller,
		)

		expect(requests).toEqual([{ type: 'oauth-client', ...manualRequest() }])
	})

	it('moves manual OAuth input to a surviving waiter after the first caller disconnects', async () => {
		const stores = await createStores({ fixture: oauthServer() })
		let firstPrompted = false
		let secondPrompted = false
		const authentication = new RuntimeAuthentication(stores, {
			authorizeOAuth: async ({ requestManualClient, grants }) => {
				await requestManualClient(manualRequest())
				await grants.update(() => freshGrant('local-access'))
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
		declared: Record<string, DeclaredServer>,
		oauth: Record<string, OAuthGrant> = {},
	) {
		const root = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-runtime-auth-'))
		roots.push(root)
		const stores = await openRuntimeStores(root)
		await stores.updateState((state) => {
			Object.assign(state.registry.servers, declared)
			Object.assign(state.credentials.oauth, oauth)
		})
		return stores
	}
})

function oauthServer(url = 'http://127.0.0.1:1/mcp'): DeclaredServer {
	return { url, auth: { kind: 'oauth' } }
}

function expiredGrant(): OAuthGrant {
	return {
		client: {
			registration: 'dynamic',
			information: { client_id: 'fixture-client' },
		},
		tokens: {
			value: {
				access_token: 'expired-access',
				refresh_token: 'refresh-1',
				token_type: 'bearer',
			},
			expiresAt: '2000-01-01T00:00:00.000Z',
		},
	}
}

function freshGrant(accessToken: string): OAuthGrant {
	return {
		client: {
			registration: 'dynamic',
			information: { client_id: 'fixture-client' },
		},
		tokens: {
			value: {
				access_token: accessToken,
				refresh_token: 'refresh-2',
				token_type: 'bearer',
			},
			expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		},
	}
}

function manualRequest() {
	return {
		serverName: 'fixture',
		redirectUri: 'http://127.0.0.1:65245/callback',
		issuer: 'http://127.0.0.1:1',
		scopes: [],
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
		onConnect?: (token: string | undefined) => void
		callTool?: (token: string | undefined) => Promise<unknown>
	} = {},
): McpRuntime {
	const sessions = new RuntimeSessionPool(stores, {
		authentication,
		connect: async (_server, connectOptions) => {
			let token = connectOptions?.token
			options.onConnect?.(token)
			const connection: McpConnection = {
				client: {
					callTool: async () => (options.callTool ?? (async () => 'ok'))(token),
					listTools: async () => ({ tools: await listTools() }),
				} as unknown as McpConnection['client'],
				close: async () => {},
				pid: () => null,
				stderr: null,
				sessionId: () => undefined,
				updateHeaders: () => {},
				updateToken: (next) => {
					token = next
				},
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
