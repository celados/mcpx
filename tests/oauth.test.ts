import { afterEach, describe, expect, it } from 'bun:test'

import type { AuthenticationProgress } from '../src/authentication-coordinator'
import type {
	AuthorizeOAuthOptions,
	ManualOAuthClientRequest,
	OAuthGrant,
} from '../src/oauth'

import { authorizeOAuth, oauthAccessToken } from '../src/oauth'

describe('oauth', () => {
	const fixtures: Bun.Server<unknown>[] = []

	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.stop(true)
	})

	it('treats a token expiring within a minute as unusable', () => {
		const now = new Date('2026-04-27T08:00:00.000Z')
		const grant = (expiresAt?: string): OAuthGrant => ({
			tokens: {
				value: { access_token: 'access', token_type: 'Bearer' },
				...(expiresAt ? { expiresAt } : {}),
			},
		})

		expect(oauthAccessToken(grant('2026-04-27T08:00:59.000Z'), now)).toBe(
			undefined,
		)
		expect(oauthAccessToken(grant('2026-04-27T08:02:00.000Z'), now)).toBe(
			'access',
		)
		expect(oauthAccessToken(grant(), now)).toBe('access')
		expect(oauthAccessToken(grant('not a date'), now)).toBe(undefined)
	})

	it('registers a client and completes browser authorization for the challenged resource', async () => {
		const fixture = serveAuthorizationServer()
		const flow = flowOptions(fixture, {
			challenge: {
				status: 401,
				resourceMetadataUrl: `${fixture.origin}/.well-known/oauth-protected-resource/mcp`,
			},
		})

		await authorizeOAuth(flow.options)

		expect(fixture.registrations).toHaveLength(1)
		const redirectUri = (fixture.registrations[0]?.redirect_uris as string[])[0]
		expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
		const authorize = new URL(flow.browserUrls[0]!)
		expect(authorize.searchParams.get('resource')).toBe(`${fixture.origin}/mcp`)
		expect(authorize.searchParams.get('scope')).toBe('mcp:tools')
		expect(fixture.tokenRequests[0]?.get('grant_type')).toBe(
			'authorization_code',
		)
		expect(flow.grant?.client).toMatchObject({
			registration: 'dynamic',
			redirectUri,
			information: { client_id: 'dynamic-client', issuer: fixture.origin },
		})
		expect(flow.grant?.tokens?.value).toMatchObject({
			access_token: 'access-1',
			refresh_token: 'refresh-1',
			issuer: fixture.origin,
		})
		expect(oauthAccessToken(flow.grant)).toBe('access-1')
		expect(flow.progress.map((progress) => progress.phase)).toEqual([
			'awaiting-browser',
		])
		expect(flow.progress[0]?.url).toBe(flow.browserUrls[0])
	})

	it('refreshes a stored grant without opening the browser', async () => {
		const fixture = serveAuthorizationServer()
		const flow = flowOptions(fixture, { grant: storedGrant(fixture.origin) })

		await authorizeOAuth(flow.options)

		expect(flow.browserUrls).toEqual([])
		expect(fixture.registrations).toEqual([])
		expect(fixture.tokenRequests[0]?.get('grant_type')).toBe('refresh_token')
		expect(fixture.tokenRequests[0]?.get('refresh_token')).toBe(
			'stored-refresh',
		)
		expect(flow.grant?.tokens?.value.access_token).toBe('access-1')
		expect(flow.grant?.client?.information.client_id).toBe('stored-client')
		expect(flow.progress.map((progress) => progress.message)).toEqual([
			'refreshing OAuth token',
		])
	})

	it('falls back to browser authorization when the refresh grant is revoked', async () => {
		const fixture = serveAuthorizationServer({ rejectRefresh: true })
		const flow = flowOptions(fixture, { grant: storedGrant(fixture.origin) })

		await authorizeOAuth(flow.options)

		expect(flow.browserUrls).toHaveLength(1)
		expect(flow.grant?.tokens?.value.access_token).toBe('access-1')
		expect(flow.grant?.client?.information.client_id).toBe('dynamic-client')
		expect(flow.progress.map((progress) => progress.message)).toContain(
			'OAuth token could not be refreshed; starting browser authorization',
		)
	})

	it('keeps tokens another flow saved while this refresh was rejected', async () => {
		const fixture = serveAuthorizationServer({ rejectRefresh: true })
		const flow = flowOptions(fixture, { grant: storedGrant(fixture.origin) })
		const replacement: OAuthGrant = {
			...storedGrant(fixture.origin),
			tokens: {
				value: { access_token: 'other-flow', token_type: 'Bearer' },
			},
		}
		fixture.onRefresh = () => {
			flow.grant = replacement
		}
		const seen: (string | undefined)[] = []
		const update = flow.options.grants.update
		flow.options.grants.update = async (change) => {
			await update(change)
			seen.push(flow.grant?.tokens?.value.access_token)
		}
		flow.options.openBrowser = () => {
			throw new Error('stop before the browser')
		}

		await expect(authorizeOAuth(flow.options)).rejects.toThrow(
			'stop before the browser',
		)

		expect(seen[0]).toBe('other-flow')
	})

	it('asks the caller for a manual client when the server has no registration endpoint', async () => {
		const fixture = serveAuthorizationServer({ registration: false })
		const requests: ManualOAuthClientRequest[] = []
		const flow = flowOptions(fixture, {
			requestManualClient: async (request) => {
				requests.push(request)
				return { clientId: 'manual-client', clientSecret: 'manual-secret' }
			},
		})

		await authorizeOAuth(flow.options)

		expect(requests).toEqual([
			{
				serverName: 'fixture',
				redirectUri: 'http://127.0.0.1:65245/callback',
				issuer: fixture.origin,
				scopes: ['mcp:tools'],
			},
		])
		const authorize = new URL(flow.browserUrls[0]!)
		expect(authorize.searchParams.get('redirect_uri')).toBe(
			'http://127.0.0.1:65245/callback',
		)
		expect(fixture.tokenRequests[0]?.get('client_secret')).toBe('manual-secret')
		expect(flow.grant?.client).toMatchObject({
			registration: 'manual',
			redirectUri: 'http://127.0.0.1:65245/callback',
			information: {
				client_id: 'manual-client',
				client_secret: 'manual-secret',
			},
		})
		expect(flow.progress.map((progress) => progress.phase)).toEqual([
			'awaiting-input',
			'awaiting-browser',
		])
	})

	it('reuses a stored manual client for a new browser authorization', async () => {
		const fixture = serveAuthorizationServer({ registration: false })
		const flow = flowOptions(fixture, {
			grant: {
				client: {
					registration: 'manual',
					redirectUri: 'http://127.0.0.1:65245/callback',
					information: {
						client_id: 'manual-client',
						client_secret: 'manual-secret',
					},
				},
			},
			requestManualClient: async () => {
				throw new Error('must not prompt again')
			},
		})

		await authorizeOAuth(flow.options)

		expect(fixture.tokenRequests[0]?.get('client_id')).toBe('manual-client')
		expect(flow.grant?.tokens?.value.access_token).toBe('access-1')
	})

	it('refuses an authorization response from another issuer', async () => {
		const fixture = serveAuthorizationServer({ callbackIssuer: 'https://evil' })
		const flow = flowOptions(fixture)

		await expect(authorizeOAuth(flow.options)).rejects.toThrow(/issuer/i)
		expect(fixture.tokenRequests).toEqual([])
		expect(flow.grant).toBeUndefined()
	})

	type FixtureOptions = {
		registration?: boolean
		rejectRefresh?: boolean
		callbackIssuer?: string
	}

	function serveAuthorizationServer(options: FixtureOptions = {}) {
		const state = {
			origin: '',
			registrations: [] as Record<string, unknown>[],
			tokenRequests: [] as URLSearchParams[],
			onRefresh: undefined as (() => void) | undefined,
			authorizedRedirect: '',
		}
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			async fetch(request): Promise<Response> {
				const url = new URL(request.url)
				const origin = state.origin
				switch (url.pathname) {
					case '/.well-known/oauth-protected-resource/mcp':
						return Response.json({
							resource: `${origin}/mcp`,
							authorization_servers: [origin],
							scopes_supported: ['mcp:tools'],
						})
					case '/.well-known/oauth-authorization-server':
						return Response.json({
							issuer: origin,
							authorization_endpoint: `${origin}/authorize`,
							token_endpoint: `${origin}/token`,
							response_types_supported: ['code'],
							code_challenge_methods_supported: ['S256'],
							token_endpoint_auth_methods_supported:
								options.registration === false
									? ['client_secret_post']
									: ['none', 'client_secret_post'],
							authorization_response_iss_parameter_supported: true,
							...(options.registration === false
								? {}
								: { registration_endpoint: `${origin}/register` }),
						})
					case '/register': {
						const body = (await request.json()) as Record<string, unknown>
						state.registrations.push(body)
						return Response.json(
							{ ...body, client_id: 'dynamic-client' },
							{ status: 201 },
						)
					}
					case '/authorize': {
						state.authorizedRedirect = url.searchParams.get('redirect_uri')!
						const redirect = new URL(state.authorizedRedirect)
						redirect.searchParams.set('code', 'code-1')
						redirect.searchParams.set('state', url.searchParams.get('state')!)
						redirect.searchParams.set('iss', options.callbackIssuer ?? origin)
						return Response.redirect(redirect.toString(), 302)
					}
					case '/token': {
						const body = new URLSearchParams(await request.text())
						state.tokenRequests.push(body)
						if (
							body.get('grant_type') === 'authorization_code' &&
							body.get('redirect_uri') !== state.authorizedRedirect
						)
							return Response.json(
								{ error: 'invalid_grant', error_description: 'redirect_uri' },
								{ status: 400 },
							)
						if (body.get('grant_type') === 'refresh_token') {
							state.onRefresh?.()
							if (options.rejectRefresh)
								return Response.json(
									{ error: 'invalid_grant' },
									{ status: 400 },
								)
						}
						return Response.json({
							access_token: 'access-1',
							refresh_token: 'refresh-1',
							token_type: 'Bearer',
							expires_in: 3600,
						})
					}
				}
				return new Response('not found', { status: 404 })
			},
		})
		fixtures.push(server)
		state.origin = `http://127.0.0.1:${server.port}`
		return state
	}

	function flowOptions(
		fixture: { origin: string },
		overrides: {
			grant?: OAuthGrant
			challenge?: AuthorizeOAuthOptions['challenge']
			requestManualClient?: AuthorizeOAuthOptions['requestManualClient']
		} = {},
	) {
		const flow = {
			grant: overrides.grant,
			browserUrls: [] as string[],
			progress: [] as AuthenticationProgress[],
			options: undefined as unknown as AuthorizeOAuthOptions,
		}
		flow.options = {
			serverName: 'fixture',
			serverUrl: new URL(`${fixture.origin}/mcp`),
			grants: {
				read: async () => flow.grant,
				update: async (change) => {
					flow.grant = change(flow.grant)
				},
			},
			challenge: overrides.challenge,
			signal: new AbortController().signal,
			report: (progress) => flow.progress.push(progress),
			requestManualClient:
				overrides.requestManualClient ??
				(async () => {
					throw new Error('unexpected manual client request')
				}),
			// The "browser" follows the authorization redirect to the loopback callback.
			openBrowser: (url) => {
				flow.browserUrls.push(url)
				void fetch(url).catch(() => {})
			},
		}
		return flow
	}
})

function storedGrant(issuer: string): OAuthGrant {
	return {
		client: {
			registration: 'dynamic',
			redirectUri: 'http://127.0.0.1:1/callback',
			information: { client_id: 'stored-client', issuer },
		},
		tokens: {
			value: {
				access_token: 'stored-access',
				refresh_token: 'stored-refresh',
				token_type: 'Bearer',
				issuer,
			},
			expiresAt: '2000-01-01T00:00:00.000Z',
		},
	}
}
