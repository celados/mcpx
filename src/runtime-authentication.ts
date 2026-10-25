import type {
	AuthenticationFlow,
	AuthenticationProgress,
} from './authentication-coordinator'
import type {
	AuthorizeOAuthOptions,
	ManualOAuthClient,
	OAuthChallenge,
	OAuthGrant,
	OAuthGrantStore,
} from './oauth'
import type { RuntimeCaller } from './runtime-caller'
import type { RuntimeEvent } from './runtime-protocol'
import type { RuntimeStores } from './runtime-stores'

import { AuthenticationCoordinator } from './authentication-coordinator'
import { authorizeOAuth, oauthAccessToken } from './oauth'
import { RuntimeOperationError } from './runtime-call'

export type AuthorizationProgress = AuthenticationProgress & {
	serverName: string
}

export type AuthorizeOptions = {
	/** The server rejected a request; its challenge says what it wants. */
	challenge?: OAuthChallenge | undefined
	signal?: AbortSignal
	onProgress?: (progress: AuthorizationProgress) => void
}

export type AuthorizeOutcome = 'ready' | 'disconnected'

export class RuntimeAuthentication {
	readonly #stores: RuntimeStores
	readonly #coordinator: AuthenticationCoordinator
	readonly #authorizeOAuth: typeof authorizeOAuth
	readonly #openBrowser: AuthorizeOAuthOptions['openBrowser']

	constructor(
		stores: RuntimeStores,
		options: {
			coordinator?: AuthenticationCoordinator
			authorizeOAuth?: typeof authorizeOAuth
			openBrowser?: AuthorizeOAuthOptions['openBrowser']
		} = {},
	) {
		this.#stores = stores
		this.#coordinator = options.coordinator ?? new AuthenticationCoordinator()
		this.#authorizeOAuth = options.authorizeOAuth ?? authorizeOAuth
		this.#openBrowser = options.openBrowser
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
	 * authorization when no refresh is possible. A 401 challenge on a server
	 * declared without auth is how OAuth is discovered after `@add`.
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

		const { challenge } = options
		if (server.auth.kind === 'bearer') {
			// Static credentials cannot be repaired by the Runtime.
			if (challenge) throw reauthRequired(serverName)
			return 'ready'
		}
		if (server.auth.kind === 'none' && !challenge) return 'ready'

		const observed = credentials.oauth[serverName]
		if (
			server.auth.kind === 'oauth' &&
			!challenge &&
			oauthAccessToken(observed)
		)
			return 'ready'
		return this.#join(serverName, `oauth:${serverName}`, caller, options, {
			start: async (signal, requestInput, report) => {
				const current = (await this.#stores.credentials.read()).oauth[
					serverName
				]
				// A caller can arrive after a shared flow persisted but before it observed
				// completion; reuse that rotation instead of authorizing again.
				if (
					current?.tokens?.value.access_token !==
						observed?.tokens?.value.access_token &&
					oauthAccessToken(current)
				)
					return
				await this.#authorizeOAuth({
					serverName,
					serverUrl: new URL(server.url),
					grants: this.#grantStore(serverName),
					challenge,
					signal,
					report,
					openBrowser: this.#openBrowser,
					requestManualClient: async (request) =>
						parseManualClient(
							serverName,
							await requestInput({ type: 'oauth-client', ...request }),
						),
				})
			},
			persist: async () => {},
		})
	}

	async #join(
		serverName: string,
		identity: string,
		caller: RuntimeCaller,
		options: AuthorizeOptions,
		flow: AuthenticationFlow<void>,
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

	/**
	 * Writes each credential the SDK produces as it arrives. Earning a grant also
	 * declares the server as OAuth, in the same commit.
	 */
	#grantStore(serverName: string): OAuthGrantStore {
		return {
			read: async () =>
				(await this.#stores.credentials.read()).oauth[serverName],
			update: (change) =>
				this.#stores.updateState((state) => {
					const next: OAuthGrant | undefined = change(
						state.credentials.oauth[serverName],
					)
					if (next) state.credentials.oauth[serverName] = next
					else delete state.credentials.oauth[serverName]
					const server = state.registry.servers[serverName]
					if (
						next?.tokens &&
						server &&
						server.transport !== 'stdio' &&
						server.auth.kind === 'none'
					)
						state.registry.servers[serverName] = {
							...server,
							auth: { kind: 'oauth' },
						}
				}),
		}
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
): ManualOAuthClient {
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
	return {
		clientId: input.clientId.trim(),
		clientSecret: input.clientSecret.trim(),
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
