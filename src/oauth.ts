import type {
	FetchLike,
	OAuthClientInformationContext,
	OAuthClientMetadata,
	OAuthClientProvider,
	OAuthDiscoveryState,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
} from '@modelcontextprotocol/client'

import {
	auth,
	computeScopeUnion,
	isStrictScopeSuperset,
} from '@modelcontextprotocol/client'
import { randomBytes } from 'node:crypto'

import type { AuthenticationProgress } from './authentication-coordinator'

/** One server's OAuth grant in the Credential Store, in the SDK's stored shapes. */
export type OAuthGrant = {
	client?: {
		information: StoredOAuthClientInformation
		/** `manual` clients were entered by the user for a fixed redirect URI. */
		registration: 'dynamic' | 'manual'
		redirectUri?: string
	}
	tokens?: {
		value: StoredOAuthTokens
		expiresAt?: string
	}
}

/** What the resource server asked for when it rejected a request. */
export type OAuthChallenge = {
	status: 401 | 403
	resourceMetadataUrl?: string
	scope?: string
}

export type OAuthGrantStore = {
	read: () => Promise<OAuthGrant | undefined>
	update: (
		change: (grant: OAuthGrant | undefined) => OAuthGrant | undefined,
	) => Promise<void>
}

export type ManualOAuthClientRequest = {
	serverName: string
	redirectUri: string
	issuer: string
	scopes: string[]
}

export type ManualOAuthClient = { clientId: string; clientSecret: string }

export type AuthorizeOAuthOptions = {
	serverName: string
	serverUrl: URL
	grants: OAuthGrantStore
	challenge?: OAuthChallenge | undefined
	signal: AbortSignal
	requestManualClient: (
		request: ManualOAuthClientRequest,
	) => Promise<ManualOAuthClient>
	report: (progress: AuthenticationProgress) => void
	openBrowser?: (url: string) => void
}

const LOCALHOST = '127.0.0.1'
const CALLBACK_PATH = '/callback'
// Manual OAuth clients require a pre-registered redirect URI; random ports break that contract.
const MANUAL_CALLBACK_PORT = 65245
const MANUAL_REDIRECT_URI = `http://${LOCALHOST}:${MANUAL_CALLBACK_PORT}${CALLBACK_PATH}`
const EXPIRY_MARGIN_MS = 60_000

export function oauthAccessToken(
	grant: OAuthGrant | undefined,
	now: Date = new Date(),
): string | undefined {
	const tokens = grant?.tokens
	if (!tokens) return undefined
	if (!tokens.expiresAt) return tokens.value.access_token
	const expiresAt = Date.parse(tokens.expiresAt)
	// An unreadable expiry cannot prove the token is usable.
	if (!Number.isFinite(expiresAt)) return undefined
	return expiresAt - now.getTime() > EXPIRY_MARGIN_MS
		? tokens.value.access_token
		: undefined
}

/**
 * Makes a server's grant usable through the SDK's `auth()`: a silent refresh
 * when the stored grant allows one, otherwise one browser authorization. Every
 * credential the SDK produces is written through to the Credential Store as it
 * arrives, so a rotated refresh token survives a cancelled flow.
 */
export async function authorizeOAuth(
	options: AuthorizeOAuthOptions,
): Promise<void> {
	const { challenge, signal } = options
	const grant = await options.grants.read()
	const grantedScope = grant?.tokens?.value.scope
	// A 403 step-up keeps what was granted and adds what the server asked for.
	const scope =
		challenge?.status === 403
			? computeScopeUnion(grantedScope, challenge.scope)
			: challenge?.scope
	const widensScope =
		challenge?.status === 403 && isStrictScopeSuperset(scope, grantedScope)
	const base = {
		serverUrl: options.serverUrl,
		scope,
		resourceMetadataUrl: challenge?.resourceMetadataUrl
			? new URL(challenge.resourceMetadataUrl)
			: undefined,
		fetchFn: oauthFetch(signal),
	}

	// A refresh grant cannot widen scope (RFC 6749 §6), so step-up skips it.
	if (grant?.client && grant.tokens?.value.refresh_token && !widensScope) {
		options.report({
			phase: 'refreshing-token',
			message: 'refreshing OAuth token',
		})
		try {
			const provider = new McpxOAuthProvider(options, grant, 'refresh')
			if ((await auth(provider, base)) === 'AUTHORIZED') return
		} catch (error) {
			if (signal.aborted) throw signal.reason ?? error
			// A revoked grant is repaired by a fresh authorization, not by asking the
			// user to remove and re-add the server.
			options.report({
				phase: 'refreshing-token',
				message:
					error instanceof InteractionRequired
						? 'OAuth token could not be refreshed; starting browser authorization'
						: `token refresh failed (${errorMessage(error)}); starting browser authorization`,
			})
		}
	}

	const state = randomBytes(24).toString('base64url')
	const callback = await OAuthCallback.start(state, signal)
	try {
		const provider = new McpxOAuthProvider(
			options,
			grant,
			'interactive',
			callback,
			state,
		)
		if ((await auth(provider, base)) === 'AUTHORIZED') return
		const params = await callback.result
		const code = params.get('code')
		if (!code) throw new Error('Invalid OAuth callback.')
		const iss = params.get('iss') ?? undefined
		// RFC 9207: the SDK checks `iss` against the issuer the redirect targeted.
		await auth(provider, {
			...base,
			authorizationCode: code,
			...(iss ? { iss } : {}),
		})
	} finally {
		callback.close()
	}
}

class InteractionRequired extends Error {
	constructor() {
		super('OAuth authorization requires the browser.')
		this.name = 'InteractionRequired'
	}
}

/**
 * The SDK drives the OAuth state machine; this provider supplies storage and
 * the browser hand-off. `refresh` mode may only refresh: reaching the browser
 * step aborts it. `interactive` mode is a new sign-in on this flow's loopback
 * callback, so it never replays the stored tokens or a dynamic client
 * registered for another port.
 */
class McpxOAuthProvider implements OAuthClientProvider {
	readonly #options: AuthorizeOAuthOptions
	readonly #stored: OAuthGrant | undefined
	readonly #mode: 'refresh' | 'interactive'
	readonly #callback: OAuthCallback | undefined
	readonly #state: string | undefined
	#client: OAuthGrant['client']
	#tokensInvalidated = false
	#verifier: string | undefined
	#discovery: OAuthDiscoveryState | undefined

	constructor(
		options: AuthorizeOAuthOptions,
		stored: OAuthGrant | undefined,
		mode: 'refresh' | 'interactive',
		callback?: OAuthCallback,
		state?: string,
	) {
		this.#options = options
		this.#stored = stored
		this.#mode = mode
		this.#callback = callback
		this.#state = state
		if (mode === 'refresh') this.#client = stored?.client
	}

	get redirectUrl(): string {
		if (this.#callback) return this.#callback.redirectUri
		return this.#client?.redirectUri ?? MANUAL_REDIRECT_URI
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: 'MCPX',
			redirect_uris: [this.redirectUrl],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
			application_type: 'native',
		}
	}

	state(): string {
		return this.#state ?? randomBytes(24).toString('base64url')
	}

	async clientInformation(
		ctx?: OAuthClientInformationContext,
	): Promise<StoredOAuthClientInformation | undefined> {
		if (this.#client) return this.#client.information
		if (this.#mode === 'refresh') throw new InteractionRequired()

		const stored = this.#stored?.client
		if (
			stored?.registration === 'manual' &&
			issuersMatch(stored.information.issuer, ctx?.issuer)
		) {
			await this.#callback?.listen(MANUAL_CALLBACK_PORT)
			this.#client = stored
			return stored.information
		}
		const metadata = this.#discovery?.authorizationServerMetadata
		// Without metadata the SDK falls back to the conventional /register path.
		if (!metadata || metadata.registration_endpoint) return undefined

		this.#options.report({
			phase: 'awaiting-input',
			message: 'waiting for OAuth client credentials in the terminal',
		})
		const issuer = ctx?.issuer ?? metadata.issuer
		const manual = await this.#options.requestManualClient({
			serverName: this.#options.serverName,
			redirectUri: MANUAL_REDIRECT_URI,
			issuer,
			scopes: this.#discovery?.resourceMetadata?.scopes_supported ?? [],
		})
		await this.#callback?.listen(MANUAL_CALLBACK_PORT)
		this.#client = {
			registration: 'manual',
			redirectUri: MANUAL_REDIRECT_URI,
			information: {
				client_id: manual.clientId,
				client_secret: manual.clientSecret,
				issuer,
			},
		}
		return this.#client.information
	}

	async saveClientInformation(
		information: StoredOAuthClientInformation,
	): Promise<void> {
		this.#client =
			this.#client?.information.client_id === information.client_id
				? { ...this.#client, information }
				: {
						information,
						registration: 'dynamic',
						redirectUri: this.redirectUrl,
					}
		// An interactive client is persisted with the tokens it earns, so a failed
		// sign-in never replaces a working grant. A refresh only back-stamps.
		if (this.#mode === 'refresh') {
			await this.#options.grants.update((grant) =>
				grant?.client?.information.client_id === information.client_id
					? { ...grant, client: { ...grant.client, information } }
					: grant,
			)
		}
	}

	tokens(): StoredOAuthTokens | undefined {
		if (this.#mode === 'interactive' || this.#tokensInvalidated)
			return undefined
		return this.#stored?.tokens?.value
	}

	async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
		const entry: NonNullable<OAuthGrant['tokens']> = { value: tokens }
		if (tokens.expires_in !== undefined) {
			entry.expiresAt = new Date(
				Date.now() + tokens.expires_in * 1000,
			).toISOString()
		}
		const client = this.#client
		await this.#options.grants.update((grant) => {
			// An issuer back-stamp re-saves the same token without `expires_in`.
			if (
				!entry.expiresAt &&
				grant?.tokens?.expiresAt &&
				grant.tokens.value.access_token === tokens.access_token
			)
				entry.expiresAt = grant.tokens.expiresAt
			const next: OAuthGrant = { tokens: entry }
			const nextClient = client ?? grant?.client
			if (nextClient) next.client = nextClient
			return next
		})
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		if (this.#mode === 'refresh') throw new InteractionRequired()
		const url = authorizationUrl.toString()
		// The Runtime's stderr is detached; callers must receive the URL as an event
		// so a failed browser launch never turns into a silent wait.
		this.#options.report({
			phase: 'awaiting-browser',
			message: `authorize in your browser (waiting up to 5 minutes): ${url}`,
			url,
		})
		;(this.#options.openBrowser ?? openBrowser)(url)
	}

	saveCodeVerifier(verifier: string): void {
		this.#verifier = verifier
	}

	codeVerifier(): string {
		if (!this.#verifier) throw new Error('OAuth code verifier is missing.')
		return this.#verifier
	}

	saveDiscoveryState(state: OAuthDiscoveryState): void {
		this.#discovery = state
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.#discovery
	}

	async invalidateCredentials(
		scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
	): Promise<void> {
		if (scope === 'all' || scope === 'verifier') this.#verifier = undefined
		if (scope === 'all' || scope === 'discovery') this.#discovery = undefined
		const client = scope === 'all' || scope === 'client'
		const tokens = scope === 'all' || scope === 'tokens'
		if (client) this.#client = undefined
		if (tokens) this.#tokensInvalidated = true
		// A new sign-in keeps the stored grant until it succeeds.
		if (this.#mode === 'interactive' || (!client && !tokens)) return
		const rejected = this.#stored
		await this.#options.grants.update((grant) => {
			if (!grant) return grant
			const next = { ...grant }
			// Delete only what the server refused: another flow may have replaced it.
			if (
				tokens &&
				grant.tokens?.value.access_token ===
					rejected?.tokens?.value.access_token
			)
				delete next.tokens
			if (
				client &&
				grant.client?.information.client_id ===
					rejected?.client?.information.client_id
			)
				delete next.client
			return next
		})
	}
}

function issuersMatch(
	stored: string | undefined,
	current: string | undefined,
): boolean {
	if (!stored || !current) return true
	return stored.replace(/\/$/, '') === current.replace(/\/$/, '')
}

/**
 * Binds every OAuth request to the flow's lifetime and accepts Slack's token
 * response, which nests a user token under `authed_user`.
 */
function oauthFetch(signal: AbortSignal): FetchLike {
	return async (url, init) => {
		const response = await fetch(url, {
			...init,
			signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
		})
		if (
			!(init?.body instanceof URLSearchParams) ||
			!init.body.has('grant_type')
		)
			return response
		return unwrapAuthedUser(response)
	}
}

async function unwrapAuthedUser(response: Response): Promise<Response> {
	if (!response.headers.get('content-type')?.includes('json')) return response
	const body = (await response
		.clone()
		.json()
		.catch(() => undefined)) as Record<string, unknown> | undefined
	const user = body?.authed_user as Record<string, unknown> | undefined
	if (!body || body.access_token || typeof user?.access_token !== 'string')
		return response
	return Response.json(user, {
		status: response.status,
		statusText: response.statusText,
	})
}

/** The loopback redirect target for one browser authorization. */
class OAuthCallback {
	readonly result: Promise<URLSearchParams>
	readonly #state: string
	#server: Bun.Server<undefined> | undefined
	// A stopped Bun server no longer reports its port; the code exchange that
	// follows the callback must repeat the exact redirect URI.
	#redirectUri: string | undefined
	#finish: (params: URLSearchParams) => void = () => {}
	#fail: (error: Error) => void = () => {}
	#settled = false

	private constructor(state: string, signal: AbortSignal) {
		this.#state = state
		this.result = new Promise<URLSearchParams>((resolve, reject) => {
			this.#finish = resolve
			this.#fail = reject
		})
		// The browser step can fail before anyone awaits the callback.
		void this.result.catch(() => {})
		const onAbort = () =>
			this.#complete(
				signal.reason instanceof Error
					? signal.reason
					: new Error('OAuth authentication cancelled.'),
			)
		if (signal.aborted) onAbort()
		else signal.addEventListener('abort', onAbort, { once: true })
		void this.result
			.finally(() => signal.removeEventListener('abort', onAbort))
			.catch(() => {})
	}

	static async start(
		state: string,
		signal: AbortSignal,
	): Promise<OAuthCallback> {
		const callback = new OAuthCallback(state, signal)
		await callback.listen(0)
		return callback
	}

	get redirectUri(): string {
		if (!this.#redirectUri)
			throw new Error('OAuth callback server is not running.')
		return this.#redirectUri
	}

	async listen(port: number): Promise<void> {
		if (this.#server && (port === 0 || this.#server.port === port)) return
		this.#server?.stop(true)
		this.#server = Bun.serve({
			hostname: LOCALHOST,
			port,
			routes: {
				[CALLBACK_PATH]: (request) => this.#receive(new URL(request.url)),
			},
			fetch: () => new Response('Not found', { status: 404 }),
		})
		this.#redirectUri = `http://${LOCALHOST}:${this.#server.port}${CALLBACK_PATH}`
		// The Authentication Flow timeout owns this lifetime, not the socket.
		this.#server.unref()
	}

	close(): void {
		this.#complete(new Error('OAuth callback server closed.'))
	}

	#receive(url: URL): Response {
		const params = url.searchParams
		if (params.get('state') !== this.#state) {
			this.#complete(new Error('Invalid OAuth callback.'))
			return new Response('Invalid OAuth callback.', { status: 400 })
		}
		const error = params.get('error')
		if (error) {
			// `error_description` may come from a mixed-up authorization server.
			this.#complete(new Error(`OAuth authorization failed: ${error}`))
			return new Response(`OAuth failed: ${error}`, { status: 400 })
		}
		if (!params.get('code')) {
			this.#complete(new Error('Invalid OAuth callback.'))
			return new Response('Invalid OAuth callback.', { status: 400 })
		}
		this.#complete(params)
		return new Response('MCPX authentication complete. You can close this tab.')
	}

	#complete(outcome: URLSearchParams | Error): void {
		if (this.#settled) return
		this.#settled = true
		this.#server?.stop()
		if (outcome instanceof Error) this.#fail(outcome)
		else this.#finish(outcome)
	}
}

function openBrowser(url: string): void {
	const command =
		process.platform === 'darwin'
			? 'open'
			: process.platform === 'win32'
				? 'cmd'
				: 'xdg-open'
	const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
	Bun.spawn([command, ...args], { stdout: 'ignore', stderr: 'ignore' })
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
