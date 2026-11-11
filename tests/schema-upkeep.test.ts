import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { McpConnection } from '../src/mcp-client'

import { jsonSchemaToStandardSchema } from '../src/json-schema-standard'
import { RuntimeAuthentication } from '../src/runtime-authentication'
import { RuntimeCall } from '../src/runtime-call'
import { createInMemoryRuntimeCaller } from '../src/runtime-caller'
import { RuntimeSessionPool } from '../src/runtime-session-pool'
import { openRuntimeStores } from '../src/runtime-stores'
import { SchemaUpkeep } from '../src/schema-upkeep'

const DAY = 24 * 60 * 60 * 1000

describe('Schema upkeep', () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(
			roots.splice(0).map((root) => fs.rm(root, { recursive: true })),
		)
	})

	it('sweeps only schemas older than a week, keeping last good tools on failure', async () => {
		const stores = await createStores({
			stale: server('stale', ago(8 * DAY)),
			fresh: server('fresh', ago(DAY)),
			down: server('down', ago(30 * DAY)),
		})
		const listed: string[] = []
		const { upkeep } = upkeepWith(stores, (url) => {
			const name = new URL(url).pathname.slice(1)
			listed.push(name)
			if (name === 'down') throw new Error('connection refused')
			return [{ name: 'echo' }, { name: 'added' }]
		})

		// Concurrent sweeps share one pass: the upkeep is exclusive.
		await Promise.all([upkeep.sweep(), upkeep.sweep()])

		expect(listed.sort()).toEqual(['down', 'stale'])
		const { schemas } = await stores.readState()
		expect(schemas.servers.stale?.tools?.map((tool) => tool.name)).toEqual([
			'echo',
			'added',
		])
		expect(schemas.servers.stale?.refreshStatus?.status).toBe('ok')
		expect(schemas.servers.fresh?.tools?.map((tool) => tool.name)).toEqual([
			'echo',
		])
		expect(schemas.servers.down?.tools?.map((tool) => tool.name)).toEqual([
			'echo',
		])
		expect(schemas.servers.down?.refreshStatus).toMatchObject({
			status: 'unreachable',
			message: expect.stringContaining('connection refused'),
		})
	})

	it('never opens a browser for an OAuth server whose token expired', async () => {
		const stores = await createStores(
			{
				locked: {
					url: 'http://127.0.0.1:1/locked',
					auth: { kind: 'oauth' },
					tools: [{ name: 'echo', commandName: 'echo' }],
					discoveredAt: ago(30 * DAY),
				},
			},
			{
				locked: {
					tokens: {
						value: { access_token: 'old', token_type: 'Bearer' },
						expiresAt: '2000-01-01T00:00:00.000Z',
					},
				},
			},
		)
		let authorizations = 0
		const { upkeep } = upkeepWith(stores, () => [{ name: 'echo' }], {
			authorizeOAuth: async () => {
				authorizations += 1
			},
		})

		await upkeep.sweep()

		expect(authorizations).toBe(0)
		const { schemas } = await stores.readState()
		expect(schemas.servers.locked?.refreshStatus?.status).toBe(
			'reauth-required',
		)
	})

	it('re-lists on reconnect when the schema is over an hour old, and on Invalid Params', async () => {
		const stores = await createStores({
			fixture: server('fixture', ago(2 * 60 * 60 * 1000)),
		})
		let lists = 0
		let reject = false
		const { upkeep, pool } = upkeepWith(
			stores,
			() => {
				lists += 1
				return [{ name: 'echo' }]
			},
			{},
			async () => {
				if (reject)
					throw Object.assign(new Error('Unknown tool: echo'), {
						code: -32602,
					})
				return { content: [{ type: 'text', text: 'ok' }] }
			},
		)

		await callEcho(pool)
		await upkeep.idle()
		expect(lists).toBe(1)

		// Fresh now: another call on the same session does not re-list.
		await callEcho(pool)
		await upkeep.idle()
		expect(lists).toBe(1)

		// A rejection re-lists at once, but not more than once a minute.
		reject = true
		await callEcho(pool)
		await upkeep.idle()
		expect(lists).toBe(1)
		await stores.updateState((state) => {
			state.schemas.servers.fixture = {
				...state.schemas.servers.fixture,
				discoveredAt: ago(2 * 60 * 1000),
				refreshStatus: { checkedAt: ago(2 * 60 * 1000), status: 'ok' },
			}
		})
		await callEcho(pool)
		await upkeep.idle()
		expect(lists).toBe(2)
	})

	it('judges a missing required field by the server schema the CLI re-synced', async () => {
		let resyncs = 0
		const stale = jsonSchemaToStandardSchema(
			{ type: 'object', required: ['removed'] },
			{
				resync: async () => {
					resyncs += 1
					return { type: 'object', required: ['query'] }
				},
			},
		)

		expect(await stale['~standard'].validate({ query: 'x' })).toEqual({
			value: { query: 'x' },
		})
		expect(await stale['~standard'].validate({})).toMatchObject({
			issues: [{ message: 'Missing required field "query".' }],
		})
		// Valid input never asks the server.
		await stale['~standard'].validate({ removed: 1 })
		expect(resyncs).toBe(2)
	})

	function upkeepWith(
		stores: Awaited<ReturnType<typeof openRuntimeStores>>,
		listTools: (url: string) => Array<{ name: string }>,
		authentication: ConstructorParameters<typeof RuntimeAuthentication>[1] = {},
		callTool: (...args: any[]) => Promise<unknown> = async () => ({
			content: [{ type: 'text', text: 'ok' }],
		}),
	) {
		let pool: RuntimeSessionPool | undefined
		const upkeep = new SchemaUpkeep(stores, () => pool!)
		pool = new RuntimeSessionPool(stores, {
			authentication: new RuntimeAuthentication(stores, authentication),
			onSchemaSignal: upkeep.signal,
			connect: async (config) => {
				const url = config.transport === 'stdio' ? '' : config.url
				return fakeConnection(async () => ({ tools: listTools(url) }), callTool)
			},
		})
		return { upkeep, pool }
	}

	async function createStores(
		servers: Record<string, unknown>,
		oauth: Record<string, unknown> = {},
	) {
		const root = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-upkeep-'))
		roots.push(root)
		await fs.writeFile(
			path.join(root, 'servers.json'),
			JSON.stringify({ version: 1, servers }),
		)
		const stores = await openRuntimeStores(root)
		if (Object.keys(oauth).length > 0)
			await stores.updateState((state) => {
				Object.assign(state.credentials.oauth, oauth)
			})
		return stores
	}
})

function server(name: string, discoveredAt: string) {
	return {
		url: `http://127.0.0.1:1/${name}`,
		auth: { kind: 'none' },
		tools: [{ name: 'echo', commandName: 'echo' }],
		discoveredAt,
	}
}

function ago(ms: number): string {
	return new Date(Date.now() - ms).toISOString()
}

async function callEcho(pool: RuntimeSessionPool): Promise<void> {
	const call = new RuntimeCall(createInMemoryRuntimeCaller(crypto.randomUUID()))
	await pool
		.call(call, { serverName: 'fixture', toolName: 'echo', input: {} })
		.catch(() => {})
}

function fakeConnection(
	listTools: () => Promise<{ tools: Array<{ name: string }> }>,
	callTool: (...args: any[]) => Promise<unknown>,
): McpConnection {
	return {
		client: { callTool, listTools } as unknown as McpConnection['client'],
		close: async () => {},
		pid: () => null,
		stderr: null,
		sessionId: () => 'fixture-session',
		updateHeaders: () => {},
		updateToken: () => {},
	}
}
