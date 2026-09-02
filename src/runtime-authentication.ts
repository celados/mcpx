import type { RuntimeCaller } from './runtime-caller'
import type { DeclaredServer, RuntimeStores } from './runtime-stores'

import { AuthenticationCoordinator } from './authentication-coordinator'
import { performOAuthAuthentication, refreshOAuthToken } from './oauth'
import { RuntimeOperationError } from './runtime-call'

type RefreshResult = Awaited<ReturnType<typeof refreshOAuthToken>>
type AuthenticationResult = Awaited<
	ReturnType<typeof performOAuthAuthentication>
>

export type RuntimeRefreshOutcome =
	| {
			status: 'completed'
			refreshed: string[]
			failed: RuntimeRefreshFailure[]
	  }
	| { status: 'disconnected' }

export type RuntimeRefreshFailure = {
	serverName: string
	message: string
}

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

	async refreshServers(
		serverNames: string[] | undefined,
		caller: RuntimeCaller,
	): Promise<RuntimeRefreshOutcome> {
		const registry = await this.#stores.registry.read()
		const names = serverNames ?? Object.keys(registry.servers).sort()
		const refreshed: string[] = []
		const failed: RuntimeRefreshFailure[] = []

		for (const name of names) {
			const server = registry.servers[name]
			if (!server) {
				throw new RuntimeOperationError(
					'operation-failed',
					`Unknown MCP server: ${name}.`,
				)
			}
			if (server.transport === 'stdio') continue

			let outcome
			try {
				outcome =
					server.auth.kind === 'oauth-token'
						? await this.#refreshExisting(name, server, caller)
						: server.auth.kind === 'oauth'
							? await this.#authenticateDiscovered(name, server, caller)
							: { status: 'completed' as const }
			} catch (error) {
				// Cancellation is operation-wide; provider-specific failures should not
				// hide the state of servers that have not been checked yet.
				if (
					error instanceof RuntimeOperationError &&
					error.code === 'cancelled'
				)
					throw error
				failed.push({
					serverName: name,
					message: `Failed to refresh ${name}: ${errorMessage(error)}`,
				})
				continue
			}
			if (outcome.status === 'disconnected') return outcome
			if (server.auth.kind === 'oauth-token' || server.auth.kind === 'oauth') {
				refreshed.push(name)
			}
		}

		return { status: 'completed', refreshed, failed }
	}

	async #refreshExisting(
		name: string,
		server: Extract<DeclaredServer, { transport?: 'http' }>,
		caller: RuntimeCaller,
	) {
		if (server.auth.kind !== 'oauth-token') {
			return { status: 'completed' as const }
		}
		const tokenKey = server.auth.tokenKey
		const credentials = await this.#stores.credentials.read()
		const token = credentials.oauth[tokenKey]
		if (!token) throw reauthRequired(name)
		const separator = tokenKey.indexOf(':')
		if (separator === -1) throw reauthRequired(name)
		const issuer = tokenKey.slice(separator + 1)
		const clientSecret = token.clientSecretKey
			? credentials.oauthClientSecrets[token.clientSecretKey]
			: undefined

		return this.#coordinator.join<RefreshResult>(`oauth:${tokenKey}`, caller, {
			start: async (signal) => {
				const current = (await this.#stores.credentials.read()).oauth[tokenKey]
				// A caller can arrive after a shared flow persisted but before it observed
				// completion; reuse that rotation instead of refreshing the stale token again.
				if (current && current.accessToken !== token.accessToken) return current
				return this.#refreshToken({
					issuer,
					resourceUrl: server.url,
					token,
					clientSecret,
					signal,
				})
			},
			persist: async (refreshed) => {
				await this.#stores.updateState((state) => {
					state.credentials.oauth[tokenKey] = refreshed
				})
			},
		})
	}

	async #authenticateDiscovered(
		name: string,
		server: Extract<DeclaredServer, { transport?: 'http' }>,
		caller: RuntimeCaller,
	) {
		if (server.auth.kind !== 'oauth') {
			return { status: 'completed' as const }
		}
		const auth = server.auth
		const authorizationServer = auth.authorizationServers?.[0]
		if (!authorizationServer) throw reauthRequired(name)
		const identity = `oauth:${name}:${authorizationServer}`

		return this.#coordinator.join<AuthenticationResult>(identity, caller, {
			start: (signal, requestInput) =>
				this.#authenticate(
					name,
					new URL(server.url),
					auth,
					signal,
					async (request) =>
						parseManualClient(
							await requestInput({
								type: 'oauth-client',
								...request,
							}),
						),
				),
			persist: async (completed) => {
				await this.#stores.updateState((state) => {
					state.credentials.oauth[completed.auth.tokenKey] = completed.token
					if (completed.clientSecret && completed.token.clientSecretKey) {
						state.credentials.oauthClientSecrets[
							completed.token.clientSecretKey
						] = completed.clientSecret
					}
					const current = state.registry.servers[name]
					if (current && current.transport !== 'stdio') {
						state.registry.servers[name] = { ...current, auth: completed.auth }
					}
				})
			},
		})
	}
}

function parseManualClient(value: unknown): {
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
		clientId?: unknown
		clientSecret?: unknown
	}
	if (input.cancelled === true)
		throw new RuntimeOperationError(
			'cancelled',
			'OAuth authentication cancelled.',
		)
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

function reauthRequired(serverName: string): RuntimeOperationError {
	return new RuntimeOperationError(
		'reauth-required',
		`Credentials for ${serverName} must be refreshed.`,
	)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
