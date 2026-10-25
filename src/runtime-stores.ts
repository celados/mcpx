import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { OAuthGrant } from './oauth'
import type {
	HttpServerConfig,
	RegistryConfig,
	ServerConfig,
	ServerRefreshStatus,
	StdioServerConfig,
	ToolDefinition,
} from './types'

import { assignCommandNames } from './names'

const STATE_DIR = 'state-v2'
const REGISTRY_FILE = 'registry.json'
const CREDENTIALS_FILE = 'credentials.json'
const SCHEMAS_FILE = 'schema-cache.json'
const TRANSACTION_FILE = 'transaction.json'
const LEGACY_REGISTRY_FILE = 'servers.json'
const LEGACY_CREDENTIALS_FILE = 'tokens.json'
const LEGACY_REGISTRY_BACKUP = 'servers.v1.backup.json'
const LEGACY_CREDENTIALS_BACKUP = 'tokens.v1.backup.json'

export type DeclaredBearerCredential =
	| { kind: 'env'; name: string }
	| { kind: 'stored'; key: string }

type DeclaredAuth =
	| Exclude<HttpServerConfig['auth'], { kind: 'bearer' }>
	| {
			kind: 'bearer'
			credentials: DeclaredBearerCredential[]
			strategy: 'round-robin'
			confidence: 'configured'
	  }

type DeclaredHttpServer = Omit<
	HttpServerConfig,
	'headers' | 'tools' | 'discoveredAt' | 'refreshStatus' | 'auth'
> & { auth: DeclaredAuth }

type DeclaredStdioServer = Omit<
	StdioServerConfig,
	'env' | 'tools' | 'discoveredAt' | 'refreshStatus'
>

export type DeclaredServer = DeclaredHttpServer | DeclaredStdioServer

export type DeclaredRegistry = {
	version: 2
	servers: Record<string, DeclaredServer>
}

export type CredentialState = {
	version: 3
	/**
	 * OAuth grants keyed by server name, the Credential Identity of an OAuth
	 * server.
	 */
	oauth: Record<string, OAuthGrant>
	bearer: Record<string, string>
	headers: Record<string, Record<string, string>>
	stdioEnv: Record<string, Record<string, string>>
}

export type ServerSchemaState = {
	discoveredAt?: string
	tools?: ToolDefinition[]
	refreshStatus?: ServerRefreshStatus
	dirty?: boolean
}

export type SchemaCache = {
	version: 1
	servers: Record<string, ServerSchemaState>
}

export type RuntimeRegistrySnapshot = {
	version: 2
	servers: Record<string, DeclaredServer & ServerSchemaState>
}

type JsonStore<T> = {
	read: () => Promise<T>
}

export type RuntimeState = {
	registry: DeclaredRegistry
	credentials: CredentialState
	schemas: SchemaCache
}

export type RuntimeStores = {
	registry: JsonStore<DeclaredRegistry>
	credentials: JsonStore<CredentialState>
	schemas: JsonStore<SchemaCache>
	readState: () => Promise<RuntimeState>
	updateState: <T>(
		update: (state: RuntimeState) => T | Promise<T>,
	) => Promise<T>
	readSnapshot: () => Promise<RuntimeRegistrySnapshot>
	upsertServer: (name: string, server: ServerConfig) => Promise<void>
	removeServers: (
		names: string[],
	) => Promise<Array<{ name: string; tokenRemoved: boolean }>>
}

type LegacyOAuthToken = {
	accessToken: string
	tokenType: string
	clientId?: string
	clientSecretKey?: string
	refreshToken?: string
	expiresAt?: string
	scope?: string
}

type LegacyCredentials = {
	version: 1
	oauth: Record<string, LegacyOAuthToken>
	oauthClientSecrets?: Record<string, string>
}

/** The pre-SDK credential generation: tokens keyed by `server:issuer`. */
type CredentialStateV2 = Omit<CredentialState, 'version' | 'oauth'> & {
	version: 2
	oauth: Record<string, LegacyOAuthToken>
	oauthClientSecrets: Record<string, string>
}

// Matches the redirect URI manual clients were registered with.
const MANUAL_REDIRECT_URI = 'http://127.0.0.1:65245/callback'

export async function openRuntimeStores(root: string): Promise<RuntimeStores> {
	const stateDir = path.join(root, STATE_DIR)
	await cleanupUnpublishedMigrations(root)
	if (!(await exists(stateDir))) await migrateLegacyState(root, stateDir)
	await recoverTransaction(stateDir)
	const paths = statePaths(stateDir)
	await upgradeCredentials(paths)
	await archiveLegacyFiles(root)

	let tail = Promise.resolve()
	let poison: Error | undefined
	const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
		const guarded = () => {
			if (poison) throw poison
			return operation()
		}
		const result = tail.then(guarded, guarded)
		tail = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}
	const readState = () => readRuntimeState(paths)
	const commitState = async (state: RuntimeState) => {
		try {
			await commitRuntimeState(paths, state)
		} catch (error) {
			poison = new Error(
				'Runtime stores are unavailable after an unrecoverable commit failure.',
				{ cause: error },
			)
			throw poison
		}
	}
	const registry = serializedJsonStore<DeclaredRegistry>(
		paths.registry,
		exclusive,
	)
	const credentials = serializedJsonStore<CredentialState>(
		paths.credentials,
		exclusive,
	)
	const schemas = serializedJsonStore<SchemaCache>(paths.schemas, exclusive)
	const updateState = <T>(
		update: (state: RuntimeState) => T | Promise<T>,
	): Promise<T> =>
		exclusive(async () => {
			const state = await readState()
			const result = await update(state)
			await commitState(state)
			return result
		})

	return {
		registry,
		credentials,
		schemas,
		readState: () => exclusive(readState),
		updateState,
		readSnapshot: () =>
			exclusive(async () => {
				const { registry: declarations, schemas: cache } = await readState()
				const servers: RuntimeRegistrySnapshot['servers'] = {}
				for (const [name, server] of Object.entries(declarations.servers)) {
					servers[name] = { ...server, ...cache.servers[name] }
				}
				return { version: 2, servers }
			}),
		upsertServer: (name, server) =>
			updateState((state) => {
				const {
					registry: declared,
					credentials: secrets,
					schemas: cache,
				} = state
				const split = splitLegacyState(
					{ version: 1, servers: { [name]: server } },
					{ version: 1, oauth: {} },
				)
				declared.servers[name] = split.registry.servers[name]!
				// A re-added server starts a new grant, like a new declaration.
				delete secrets.oauth[name]
				delete secrets.headers[name]
				delete secrets.stdioEnv[name]
				for (const key of Object.keys(secrets.bearer)) {
					if (key.startsWith(`${name}:bearer:`)) delete secrets.bearer[key]
				}
				Object.assign(secrets.bearer, split.credentials.bearer)
				Object.assign(secrets.headers, split.credentials.headers)
				Object.assign(secrets.stdioEnv, split.credentials.stdioEnv)
				if (split.schemas.servers[name]) {
					cache.servers[name] = split.schemas.servers[name]
				} else {
					delete cache.servers[name]
				}
				sweepUnreferencedOAuth(state)
			}),
		removeServers: (names) =>
			updateState((state) => {
				const {
					registry: declared,
					credentials: secrets,
					schemas: cache,
				} = state
				const removed: Array<{ name: string; tokenRemoved: boolean }> = []
				for (const name of names) {
					const server = declared.servers[name]
					if (!server) continue
					const tokenRemoved = secrets.oauth[name] !== undefined
					delete declared.servers[name]
					delete cache.servers[name]
					delete secrets.headers[name]
					delete secrets.stdioEnv[name]
					for (const key of Object.keys(secrets.bearer)) {
						if (key.startsWith(`${name}:bearer:`)) delete secrets.bearer[key]
					}
					removed.push({ name, tokenRemoved })
				}
				sweepUnreferencedOAuth(state)
				return removed
			}),
	}
}

async function cleanupUnpublishedMigrations(root: string): Promise<void> {
	// Runtime startup ownership makes every staging directory here an abandoned transaction.
	const entries = await fs
		.readdir(root, { withFileTypes: true })
		.catch((error) => {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
			throw error
		})
	await Promise.all(
		entries
			.filter(
				(entry) =>
					entry.isDirectory() && entry.name.startsWith(`.${STATE_DIR}.`),
			)
			.map((entry) =>
				fs.rm(path.join(root, entry.name), { recursive: true, force: true }),
			),
	)
}

async function migrateLegacyState(
	root: string,
	stateDir: string,
): Promise<void> {
	const registry = (await readOptionalJson<RegistryConfig>(
		path.join(root, LEGACY_REGISTRY_FILE),
	)) ?? { version: 1, servers: {} }
	const credentials = (await readOptionalJson<LegacyCredentials>(
		path.join(root, LEGACY_CREDENTIALS_FILE),
	)) ?? { version: 1, oauth: {} }
	const migrated = splitLegacyState(registry, credentials)
	const stagingDir = path.join(root, `.${STATE_DIR}.${randomUUID()}`)

	await fs.mkdir(stagingDir, { recursive: true, mode: 0o700 })
	try {
		await Promise.all([
			writeJson(path.join(stagingDir, REGISTRY_FILE), migrated.registry),
			writeJson(path.join(stagingDir, CREDENTIALS_FILE), migrated.credentials),
			writeJson(path.join(stagingDir, SCHEMAS_FILE), migrated.schemas),
		])
		// Directory publication is the commit point, so readers never see a subset.
		await fs.rename(stagingDir, stateDir)
	} catch (error) {
		await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
		throw error
	}
}

function splitLegacyState(
	registry: RegistryConfig,
	legacyCredentials: LegacyCredentials,
): {
	registry: DeclaredRegistry
	credentials: CredentialStateV2
	schemas: SchemaCache
} {
	const declarations: DeclaredRegistry = { version: 2, servers: {} }
	const credentials: CredentialStateV2 = {
		version: 2,
		oauth: legacyCredentials.oauth,
		oauthClientSecrets: legacyCredentials.oauthClientSecrets ?? {},
		bearer: {},
		headers: {},
		stdioEnv: {},
	}
	const schemas: SchemaCache = { version: 1, servers: {} }

	for (const [name, server] of Object.entries(registry.servers)) {
		if (server.transport === 'stdio') {
			const { env, tools, discoveredAt, refreshStatus, ...declared } = server
			declarations.servers[name] = declared
			if (env && Object.keys(env).length > 0) credentials.stdioEnv[name] = env
			recordSchema(name, schemas, tools, discoveredAt, refreshStatus)
		} else {
			const { headers, tools, discoveredAt, refreshStatus, ...declared } =
				server
			declarations.servers[name] = {
				...declared,
				auth: migrateAuth(name, server, credentials),
			}
			if (headers && Object.keys(headers).length > 0) {
				credentials.headers[name] = headers
			}
			recordSchema(name, schemas, tools, discoveredAt, refreshStatus)
		}
	}

	return { registry: declarations, credentials, schemas }
}

function migrateAuth(
	name: string,
	server: HttpServerConfig,
	credentials: Pick<CredentialState, 'bearer'>,
): DeclaredAuth {
	if (server.auth.kind !== 'bearer') return server.auth

	return {
		...server.auth,
		credentials: server.auth.credentials.map((credential, index) => {
			if (credential.kind === 'env') return credential
			const key = `${name}:bearer:${index}`
			credentials.bearer[key] = credential.value
			return { kind: 'stored' as const, key }
		}),
	}
}

function recordSchema(
	name: string,
	cache: SchemaCache,
	tools: ToolDefinition[] | undefined,
	discoveredAt: string | undefined,
	refreshStatus: ServerRefreshStatus | undefined,
): void {
	const schema: ServerSchemaState = {}
	if (discoveredAt) schema.discoveredAt = discoveredAt
	if (refreshStatus) schema.refreshStatus = refreshStatus
	if (tools && tools.length > 0) schema.tools = normalizeTools(tools)
	if (Object.keys(schema).length > 0) cache.servers[name] = schema
}

function normalizeTools(tools: ToolDefinition[]): ToolDefinition[] {
	const commandNames = assignCommandNames(tools.map((tool) => tool.name))
	return tools.map((tool) => {
		const { outputSchema: _outputSchema, ...rest } = tool as ToolDefinition & {
			outputSchema?: unknown
		}
		return {
			...rest,
			commandName: commandNames.get(tool.name) ?? tool.name,
		}
	})
}

function serializedJsonStore<T>(
	filePath: string,
	exclusive: <R>(operation: () => Promise<R>) => Promise<R>,
): JsonStore<T> {
	return {
		read: () => exclusive(() => readJson<T>(filePath)),
	}
}

type RuntimeStatePaths = {
	registry: string
	credentials: string
	schemas: string
	transaction: string
}

function statePaths(stateDir: string): RuntimeStatePaths {
	return {
		registry: path.join(stateDir, REGISTRY_FILE),
		credentials: path.join(stateDir, CREDENTIALS_FILE),
		schemas: path.join(stateDir, SCHEMAS_FILE),
		transaction: path.join(stateDir, TRANSACTION_FILE),
	}
}

async function readRuntimeState(
	paths: RuntimeStatePaths,
): Promise<RuntimeState> {
	const [registry, credentials, schemas] = await Promise.all([
		readJson<DeclaredRegistry>(paths.registry),
		readJson<CredentialState>(paths.credentials),
		readJson<SchemaCache>(paths.schemas),
	])
	credentials.stdioEnv ??= {}
	return { registry, credentials, schemas }
}

async function commitRuntimeState(
	paths: RuntimeStatePaths,
	state: RuntimeState,
	publish: StatePublisher = publishRuntimeState,
): Promise<void> {
	// The journal makes a multi-file commit recoverable after any process crash.
	await atomicWriteJson(paths.transaction, state)
	try {
		await publish(paths, state)
	} catch {
		// Do not permit a mixed generation to feed the next transaction in this process.
		await publish(paths, state)
	}
	await fs.rm(paths.transaction)
}

type StatePublisher = (
	paths: RuntimeStatePaths,
	state: RuntimeState,
) => Promise<void>

async function publishRuntimeState(
	paths: RuntimeStatePaths,
	state: RuntimeState,
): Promise<void> {
	await Promise.all([
		atomicWriteJson(paths.registry, state.registry),
		atomicWriteJson(paths.credentials, state.credentials),
		atomicWriteJson(paths.schemas, state.schemas),
	])
}

async function recoverTransaction(stateDir: string): Promise<void> {
	const paths = statePaths(stateDir)
	const state = await readOptionalJson<RuntimeState>(paths.transaction)
	if (!state) return
	await Promise.all([
		atomicWriteJson(paths.registry, state.registry),
		atomicWriteJson(paths.credentials, state.credentials),
		atomicWriteJson(paths.schemas, state.schemas),
	])
	await fs.rm(paths.transaction)
}

function sweepUnreferencedOAuth(state: RuntimeState): void {
	for (const name of Object.keys(state.credentials.oauth)) {
		const server = state.registry.servers[name]
		// An unauthenticated server may be earning its first grant from a 401.
		if (server && server.transport !== 'stdio' && server.auth.kind !== 'bearer')
			continue
		delete state.credentials.oauth[name]
	}
}

/**
 * Moves pre-SDK OAuth tokens into per-server grants in the SDK's shapes. The
 * journaled commit makes the registry and credential rewrite one generation.
 */
async function upgradeCredentials(paths: RuntimeStatePaths): Promise<void> {
	const state = await readRuntimeState(paths)
	const legacy = state.credentials as unknown as
		| CredentialStateV2
		| CredentialState
	if (legacy.version === 3) return

	const oauth: CredentialState['oauth'] = {}
	for (const [name, server] of Object.entries(state.registry.servers)) {
		if (server.transport === 'stdio') continue
		const auth = server.auth as { kind: string; tokenKey?: string }
		if (auth.kind === 'oauth-token') {
			server.auth = { kind: 'oauth' }
			const token = auth.tokenKey ? legacy.oauth[auth.tokenKey] : undefined
			if (token) oauth[name] = grantFromLegacyToken(token, legacy)
		} else if (auth.kind === 'oauth') {
			server.auth = { kind: 'oauth' }
		} else if (auth.kind === 'unknown') {
			// The next 401 challenge decides; a stale guess must not block Calls.
			server.auth = { kind: 'none' }
		}
	}
	state.credentials = {
		version: 3,
		oauth,
		bearer: legacy.bearer,
		headers: legacy.headers,
		stdioEnv: legacy.stdioEnv ?? {},
	}
	await commitRuntimeState(paths, state)
}

function grantFromLegacyToken(
	token: LegacyOAuthToken,
	legacy: CredentialStateV2,
): OAuthGrant {
	const grant: OAuthGrant = {
		tokens: {
			value: { access_token: token.accessToken, token_type: token.tokenType },
		},
	}
	if (token.refreshToken) grant.tokens!.value.refresh_token = token.refreshToken
	if (token.scope) grant.tokens!.value.scope = token.scope
	if (token.expiresAt) grant.tokens!.expiresAt = token.expiresAt
	if (token.clientId) {
		const secret = token.clientSecretKey
			? legacy.oauthClientSecrets[token.clientSecretKey]
			: undefined
		grant.client = secret
			? {
					registration: 'manual',
					redirectUri: MANUAL_REDIRECT_URI,
					information: { client_id: token.clientId, client_secret: secret },
				}
			: {
					registration: 'dynamic',
					information: { client_id: token.clientId },
				}
	}
	return grant
}

export const __test = {
	commitRuntimeState,
}

async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await fs.readFile(filePath, 'utf8')) as T
}

async function atomicWriteJson(
	filePath: string,
	value: unknown,
): Promise<void> {
	const tempPath = `${filePath}.${randomUUID()}.tmp`
	await writeJson(tempPath, value)
	await fs.rename(tempPath, filePath)
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.writeFile(filePath, `${JSON.stringify(value, null, '\t')}\n`, {
		encoding: 'utf8',
		mode: 0o600,
	})
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.readFile(filePath, 'utf8')) as T
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
}

async function archiveLegacyFiles(root: string): Promise<void> {
	await Promise.all([
		archiveLegacyFile(root, LEGACY_REGISTRY_FILE, LEGACY_REGISTRY_BACKUP),
		archiveLegacyFile(root, LEGACY_CREDENTIALS_FILE, LEGACY_CREDENTIALS_BACKUP),
	])
}

async function archiveLegacyFile(
	root: string,
	legacyName: string,
	backupName: string,
): Promise<void> {
	const legacyPath = path.join(root, legacyName)
	const backupPath = path.join(root, backupName)
	if (!(await exists(legacyPath))) return
	if (await exists(backupPath)) {
		// Published v2 state is authoritative; keep exactly one recovery copy.
		await fs.rm(legacyPath)
		return
	}
	await fs.rename(legacyPath, backupPath)
}

async function exists(filePath: string): Promise<boolean> {
	return fs
		.access(filePath)
		.then(() => true)
		.catch(() => false)
}
