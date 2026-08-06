import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { __test, openRuntimeStores } from '../src/runtime-stores'

describe('Runtime state stores', () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(
			roots.splice(0).map((root) => fs.rm(root, { recursive: true })),
		)
	})

	it('migrates declarations, credentials, and cached schemas into separate stores', async () => {
		const root = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-runtime-stores-'))
		roots.push(root)
		await fs.writeFile(
			path.join(root, 'servers.json'),
			JSON.stringify({
				version: 1,
				servers: {
					fixture: {
						url: 'https://fixture.example/mcp',
						headers: { 'x-api-key': 'header-secret' },
						auth: {
							kind: 'bearer',
							strategy: 'round-robin',
							confidence: 'configured',
							credentials: [
								{ kind: 'literal', value: 'bearer-secret' },
								{ kind: 'env', name: 'FIXTURE_TOKEN' },
							],
						},
						discoveredAt: '2026-08-01T00:00:00.000Z',
						refreshStatus: {
							checkedAt: '2026-08-02T00:00:00.000Z',
							status: 'ok',
						},
						tools: [{ name: 'search.items', description: 'Search items' }],
					},
					stdio: {
						transport: 'stdio',
						command: 'fixture-command',
						env: { FIXTURE_SECRET: 'stdio-secret' },
					},
				},
			}),
		)
		await fs.writeFile(
			path.join(root, 'tokens.json'),
			JSON.stringify({
				version: 1,
				oauth: {
					'fixture:issuer': {
						accessToken: 'oauth-secret',
						tokenType: 'bearer',
					},
				},
				oauthClientSecrets: { fixture: 'client-secret' },
			}),
		)

		const stores = await openRuntimeStores(root)

		expect(await stores.registry.read()).toEqual({
			version: 2,
			servers: {
				fixture: {
					url: 'https://fixture.example/mcp',
					auth: {
						kind: 'bearer',
						strategy: 'round-robin',
						confidence: 'configured',
						credentials: [
							{ kind: 'stored', key: 'fixture:bearer:0' },
							{ kind: 'env', name: 'FIXTURE_TOKEN' },
						],
					},
				},
				stdio: { transport: 'stdio', command: 'fixture-command' },
			},
		})
		expect(await stores.credentials.read()).toEqual({
			version: 2,
			oauth: {
				'fixture:issuer': {
					accessToken: 'oauth-secret',
					tokenType: 'bearer',
				},
			},
			oauthClientSecrets: { fixture: 'client-secret' },
			bearer: { 'fixture:bearer:0': 'bearer-secret' },
			headers: { fixture: { 'x-api-key': 'header-secret' } },
			stdioEnv: { stdio: { FIXTURE_SECRET: 'stdio-secret' } },
		})
		expect(await stores.schemas.read()).toEqual({
			version: 1,
			servers: {
				fixture: {
					discoveredAt: '2026-08-01T00:00:00.000Z',
					refreshStatus: {
						checkedAt: '2026-08-02T00:00:00.000Z',
						status: 'ok',
					},
					tools: [
						{
							name: 'search.items',
							commandName: 'search-items',
							description: 'Search items',
						},
					],
				},
			},
		})

		const snapshot = await stores.readSnapshot()
		expect(snapshot.servers.fixture?.tools?.[0]?.commandName).toBe(
			'search-items',
		)
		expect(JSON.stringify(snapshot)).not.toContain('secret')
	})

	it('serializes concurrent state updates without losing identities', async () => {
		const root = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-runtime-stores-'))
		roots.push(root)
		const stores = await openRuntimeStores(root)

		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				stores.updateState(async (state) => {
					await Bun.sleep(index % 3)
					state.credentials.bearer[`identity-${index}`] = `value-${index}`
				}),
			),
		)

		expect(Object.keys((await stores.credentials.read()).bearer)).toHaveLength(
			12,
		)
	})

	it('retains shared OAuth material until its final declaration is removed', async () => {
		const root = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-runtime-stores-'))
		roots.push(root)
		const stores = await openRuntimeStores(root)
		await stores.updateState((state) => {
			state.registry.servers.first = {
				url: 'http://127.0.0.1:1/mcp',
				auth: {
					kind: 'oauth-token',
					tokenKey: 'shared',
					confidence: 'confirmed',
				},
			}
			state.registry.servers.second = {
				url: 'http://127.0.0.1:1/mcp',
				auth: {
					kind: 'oauth-token',
					tokenKey: 'shared',
					confidence: 'confirmed',
				},
			}
			state.credentials.oauth.shared = {
				accessToken: 'shared-secret',
				tokenType: 'bearer',
				clientId: 'client',
				clientSecretKey: 'client-secret-key',
			}
			state.credentials.oauthClientSecrets['client-secret-key'] =
				'client-secret'
		})

		await stores.removeServers(['first'])
		expect((await stores.credentials.read()).oauth.shared).toBeDefined()
		await stores.removeServers(['second'])
		const credentials = await stores.credentials.read()
		expect(credentials.oauth.shared).toBeUndefined()
		expect(credentials.oauthClientSecrets['client-secret-key']).toBeUndefined()
	})

	it('reopens the published state without reviving a legacy registry', async () => {
		const root = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-runtime-stores-'))
		roots.push(root)
		await fs.writeFile(
			path.join(root, 'servers.json'),
			JSON.stringify({
				version: 1,
				servers: {
					original: {
						url: 'https://original.example/mcp',
						auth: { kind: 'none' },
					},
				},
			}),
		)
		await openRuntimeStores(root)
		await fs.writeFile(
			path.join(root, 'servers.json'),
			JSON.stringify({
				version: 1,
				servers: {
					stale: {
						url: 'https://stale.example/mcp',
						auth: { kind: 'none' },
					},
				},
			}),
		)

		const reopened = await openRuntimeStores(root)

		expect(Object.keys((await reopened.registry.read()).servers)).toEqual([
			'original',
		])
		expect(await fileExists(path.join(root, 'servers.json'))).toBe(false)
		expect(await fileExists(path.join(root, 'servers.v1.backup.json'))).toBe(
			true,
		)
	})

	it('recovers from an unpublished migration staging directory', async () => {
		const root = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-runtime-stores-'))
		roots.push(root)
		await fs.writeFile(
			path.join(root, 'servers.json'),
			JSON.stringify({
				version: 1,
				servers: {
					fixture: {
						url: 'https://fixture.example/mcp',
						auth: { kind: 'none' },
					},
				},
			}),
		)
		const interrupted = path.join(root, '.state-v2.interrupted')
		await fs.mkdir(interrupted)
		await fs.writeFile(
			path.join(interrupted, 'registry.json'),
			'{"partial":true}',
		)

		const stores = await openRuntimeStores(root)

		expect(Object.keys((await stores.registry.read()).servers)).toEqual([
			'fixture',
		])
		expect(await fileExists(interrupted)).toBe(false)
	})

	it('finishes a journaled multi-store commit after an interrupted publication', async () => {
		const root = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-runtime-stores-'))
		roots.push(root)
		await openRuntimeStores(root)
		const stateDir = path.join(root, 'state-v2')
		await fs.writeFile(
			path.join(stateDir, 'transaction.json'),
			JSON.stringify({
				registry: {
					version: 2,
					servers: { recovered: { transport: 'stdio', command: 'fixture' } },
				},
				credentials: {
					version: 2,
					oauth: {},
					oauthClientSecrets: {},
					bearer: {},
					headers: {},
					stdioEnv: { recovered: { LOCAL_SECRET: 'secret' } },
				},
				schemas: { version: 1, servers: {} },
			}),
		)
		await fs.writeFile(
			path.join(stateDir, 'registry.json'),
			JSON.stringify({ version: 2, servers: {} }),
		)

		const recovered = await openRuntimeStores(root)

		expect((await recovered.registry.read()).servers.recovered).toBeDefined()
		expect((await recovered.credentials.read()).stdioEnv.recovered).toEqual({
			LOCAL_SECRET: 'secret',
		})
		expect(await fileExists(path.join(stateDir, 'transaction.json'))).toBe(
			false,
		)
	})

	it('replays a publication failure before allowing another state generation', async () => {
		const root = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-runtime-stores-'))
		roots.push(root)
		const stores = await openRuntimeStores(root)
		const state = await stores.readState()
		state.registry.servers.replayed = { transport: 'stdio', command: 'fixture' }
		state.credentials.stdioEnv.replayed = { LOCAL_SECRET: 'secret' }
		const stateDir = path.join(root, 'state-v2')
		const paths = {
			registry: path.join(stateDir, 'registry.json'),
			credentials: path.join(stateDir, 'credentials.json'),
			schemas: path.join(stateDir, 'schema-cache.json'),
			transaction: path.join(stateDir, 'transaction.json'),
		}
		let attempts = 0

		await __test.commitRuntimeState(paths, state, async (target, value) => {
			attempts += 1
			await fs.writeFile(target.registry, JSON.stringify(value.registry))
			if (attempts === 1) throw new Error('injected publication failure')
			await Promise.all([
				fs.writeFile(target.credentials, JSON.stringify(value.credentials)),
				fs.writeFile(target.schemas, JSON.stringify(value.schemas)),
			])
		})

		expect(attempts).toBe(2)
		const reopened = await openRuntimeStores(root)
		expect((await reopened.registry.read()).servers.replayed).toBeDefined()
		expect((await reopened.credentials.read()).stdioEnv.replayed).toEqual({
			LOCAL_SECRET: 'secret',
		})
		expect(await fileExists(paths.transaction)).toBe(false)
	})
})

async function fileExists(filePath: string): Promise<boolean> {
	return fs
		.access(filePath)
		.then(() => true)
		.catch(() => false)
}
