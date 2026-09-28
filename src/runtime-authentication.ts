import type {
	AuthenticationFlow,
	AuthenticationProgress,
} from './authentication-coordinator'
import type { RuntimeCaller } from './runtime-caller'
import type { RuntimeEvent } from './runtime-protocol'
import type { DeclaredServer, RuntimeStores } from './runtime-stores'
import type { AuthDiscovery, OAuthToken } from './types'

import { AuthenticationCoordinator } from './authentication-coordinator'
import {
	performOAuthAuthentication,
	refreshOAuthToken,
	shouldRefreshOAuthToken,
} from './oauth'
import { RuntimeOperationError } from './runtime-call'

type HttpServer = Extract<DeclaredServer, { transport?: 'http' }>
type DiscoveredOAuth = Extract<AuthDiscovery, { kind: 'oauth' }>
type AuthenticatedOAuth = Extract<AuthDiscovery, { kind: 'oauth-token' }>

type Authorized = {
	tokenKey: string
	token: OAuthToken
	auth?: AuthenticatedOAuth
	clientSecret?: string
}

export type AuthorizationProgress = AuthenticationProgress & {
	serverName: string
}

export type AuthorizeOptions = {
	/** The server rejected the current credential, so it must be replaced. */
	rejected?: boolean
	signal?: AbortSignal
	onProgress?: (progress: AuthorizationProgress) => void
}

export type AuthorizeOutcome = 'ready' | 'disconnected'

export class RuntimeAuthentication {
	readonly #stores: RuntimeStores
	readonly #coordinator: AuthenticationCoordinator
	readonly #refreshToken: typeof refreshOAuthToken
	readonly #authenticate: typeof performOAuthAuthentication

	constructor(
		stores: RuntimeStores,
		options: {
			coordinator?: AuthenticationCoordinator
			refreshToken?: typeof refreshOAuthToken
			authenticate?: typeof performOAuthAuthentication
		} = {},
	) {
		this.#stores = stores
		this.#coordinator = options.coordinator ?? new AuthenticationCoordinator()
		this.#refreshToken = options.refreshToken ?? refreshOAuthToken
		this.#authenticate = options.authenticate ?? performOAuthAuthentication
	}

	async close(): Promise<void> {
		await this.#coordinator.close()
	}

	activeFlows(): number {
		return this.#coordinator.activeFlows()
	}

	/**
	 * Makes a server's credential usable, joining the single shared flow for its
	 * Credential Identity: a silent token refresh first, then browser
	 * authorization when no refresh is possible.
	 */
	async authorize(
		serverName: string,
		caller: RuntimeCaller,
		options: AuthorizeOptions = {},
	): Promise<AuthorizeOutcome> {
		const { registry, credentials } = await this.#stores.readState()
		const server = registry.servers[serverName]
		if (!server) {
			throw new RuntimeOperationError(
				'operation-failed',
				`Unknown MCP server: ${serverName}.`,
			)
		}
		if (server.transport === 'stdio') return 'ready'

		const auth = server.auth
		if (auth.kind === 'oauth-token') {
			const observed = credentials.oauth[auth.tokenKey]
			if (observed && !options.rejected && !shouldRefreshOAuthToken(observed))
				return 'ready'
			return this.#join(
				serverName,
				`oauth:${auth.tokenKey}`,
				caller,
				options,
				this.#tokenFlow(serverName, server, auth.tokenKey, observed),
			)
		}
		if (auth.kind === 'oauth') {
			const authorizationServer = auth.authorizationServers?.[0]
			if (!authorizationServer) {
				throw reauthRequired(
					serverName,
					'no OAuth authorization server was discovered',
				)
			}
			return this.#join(
				serverName,
				`oauth:${serverName}:${authorizationServer}`,
				caller,
				options,
				{
					start: (signal, requestInput, report) =>
						this.#authorizeInBrowser(
							serverName,
							server,
							auth,
							signal,
							requestInput,
							report,
						),
					persist: (authorized) => this.#persist(serverName, authorized),
				},
			)
		}
		if (auth.kind === 'unknown') throw reauthRequired(serverName, auth.reason)
		// Static credentials cannot be repaired by the Runtime.
		if (options.rejected) throw reauthRequired(serverName)
		return 'ready'
	}

	async #join(
		serverName: string,
		identity: string,
		caller: RuntimeCaller,
		options: AuthorizeOptions,
		flow: AuthenticationFlow<Authorized>,
	): Promise<AuthorizeOutcome> {
		const waiting = this.#coordinator.join(identity, caller, flow, (progress) =>
			options.onProgress?.({ serverName, ...progress }),
		)
		try {
			const outcome = await abortable(waiting, options.signal)
			return outcome.status === 'completed' ? 'ready' : 'disconnected'
		} catch (error) {
			throw authorizationFailure(serverName, error)
		}
	}

	#tokenFlow(
		serverName: string,
		server: HttpServer,
		tokenKey: string,
		observed: OAuthToken | undefined,
	): AuthenticationFlow<Authorized> {
		return {
			start: async (signal, requestInput, report) => {
				const separator = tokenKey.indexOf(':')
				if (separator === -1) throw reauthRequired(serverName)
				const issuer = tokenKey.slice(separator + 1)
				const credentials = await this.#stores.credentials.read()
				const current = credentials.oauth[tokenKey]
				// A caller can arrive after a shared flow persisted but before it observed
				// completion; reuse that rotation instead of refreshing it again.
				if (
					current &&
					current.accessToken !== observed?.accessToken &&
					!shouldRefreshOAuthToken(current)
				)
					return { tokenKey, token: current }

				if (current?.refreshToken && current.clientId) {
					report({
						phase: 'refreshing-token',
						message: 'refreshing OAuth token',
					})
					try {
						const refreshOptions: Parameters<typeof refreshOAuthToken>[0] = {
							issuer,
							resourceUrl: server.url,
							token: current,
							signal,
						}
						const clientSecret = current.clientSecretKey
							? credentials.oauthClientSecrets[current.clientSecretKey]
							: undefined
						if (clientSecret) refreshOptions.clientSecret = clientSecret
						return { tokenKey, token: await this.#refreshToken(refreshOptions) }
					} catch (error) {
						if (signal.aborted) throw error
						// A revoked grant is repaired by a fresh authorization, not by
						// asking the user to remove and re-add the server.
						report({
							phase: 'refreshing-token',
							message: `token refresh failed (${errorMessage(error)}); starting browser authorization`,
						})
					}
				}

				const auth: DiscoveredOAuth = {
					kind: 'oauth',
					confidence: 'confirmed',
					authorizationServers: [issuer],
				}
				const scopes = current?.scope?.split(' ').filter(Boolean)
				if (scopes?.length) auth.scopesSupported = scopes
				return this.#authorizeInBrowser(
					serverName,
					server,
					auth,
					signal,
					requestInput,
					report,
				)
			},
			persist: (authorized) => this.#persist(serverName, authorized),
		}
	}

	async #authorizeInBrowser(
		serverName: string,
		server: HttpServer,
		auth: DiscoveredOAuth,
		signal: AbortSignal,
		requestInput: RuntimeCaller['requestInput'],
		report: (progress: AuthenticationProgress) => void,
	): Promise<Authorized> {
		const completed = await this.#authenticate(
			serverName,
			new URL(server.url),
			auth,
			signal,
			async (request) => {
				report({
					phase: 'awaiting-input',
					message: 'waiting for OAuth client credentials in the terminal',
				})
				return parseManualClient(
					serverName,
					await requestInput({ type: 'oauth-client', ...request }),
				)
			},
			(url) =>
				report({
					phase: 'awaiting-browser',
					message: `authorize in your browser (waiting up to 5 minutes): ${url}`,
					url,
				}),
		)
		const authorized: Authorized = {
			tokenKey: completed.auth.tokenKey,
			token: completed.token,
			auth: completed.auth,
		}
		if (completed.clientSecret) authorized.clientSecret = completed.clientSecret
		return authorized
	}

	async #persist(serverName: string, authorized: Authorized): Promise<void> {
		await this.#stores.updateState((state) => {
			state.credentials.oauth[authorized.tokenKey] = authorized.token
			if (authorized.clientSecret && authorized.token.clientSecretKey) {
				state.credentials.oauthClientSecrets[authorized.token.clientSecretKey] =
					authorized.clientSecret
			}
			const current = state.registry.servers[serverName]
			if (authorized.auth && current && current.transport !== 'stdio') {
				state.registry.servers[serverName] = {
					...current,
					auth: authorized.auth,
				}
			}
		})
	}
}

export function progressEvent(progress: {
	serverName: string
	phase: string
	message: string
	url?: string
}): RuntimeEvent {
	return {
		type: 'progress',
		message: `${progress.serverName}: ${progress.message}`,
		data: progress,
	}
}

export function reauthRequired(
	serverName: string,
	detail?: string,
): RuntimeOperationError {
	return new RuntimeOperationError(
		'reauth-required',
		detail
			? `Credentials for ${serverName} must be refreshed: ${detail}`
			: `Credentials for ${serverName} must be refreshed.`,
	)
}

function authorizationFailure(serverName: string, error: unknown): Error {
	if (error instanceof RuntimeOperationError) {
		if (error.code === 'timeout') {
			return new RuntimeOperationError(
				'timeout',
				`Authorization for ${serverName} was not completed within 5 minutes. Run mcpx @refresh to retry.`,
			)
		}
		if (error.code === 'operation-failed')
			return reauthRequired(serverName, error.message)
		return error
	}
	if (error instanceof Error && error.name === 'RuntimeCallCancelled')
		return error
	return reauthRequired(serverName, errorMessage(error))
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise
	// Leaving the race must not leave the shared flow's rejection unhandled.
	void promise.catch(() => {})
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason)
		if (signal.aborted) {
			onAbort()
			return
		}
		signal.addEventListener('abort', onAbort, { once: true })
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener('abort', onAbort)
				reject(error)
			},
		)
	})
}

function parseManualClient(
	serverName: string,
	value: unknown,
): {
	clientId: string
	clientSecret: string
	clientSecretKey: string
} {
	if (!value || typeof value !== 'object')
		throw new RuntimeOperationError(
			'cancelled',
			'OAuth authentication cancelled.',
		)
	const input = value as {
		cancelled?: unknown
		reason?: unknown
		clientId?: unknown
		clientSecret?: unknown
	}
	if (input.cancelled === true) {
		// The adapter could not prompt (no terminal) rather than the user declining.
		if (typeof input.reason === 'string' && input.reason) {
			throw reauthRequired(
				serverName,
				`OAuth client credentials must be entered interactively (${input.reason}). Run mcpx @refresh in a terminal`,
			)
		}
		throw new RuntimeOperationError(
			'cancelled',
			'OAuth authentication cancelled.',
		)
	}
	if (
		typeof input.clientId !== 'string' ||
		!input.clientId.trim() ||
		typeof input.clientSecret !== 'string' ||
		!input.clientSecret.trim()
	) {
		throw new RuntimeOperationError(
			'operation-failed',
			'OAuth client credentials were invalid.',
		)
	}
	const clientId = input.clientId.trim()
	return {
		clientId,
		clientSecret: input.clientSecret.trim(),
		clientSecretKey: `oauth-client:${clientId}`,
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
