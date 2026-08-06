import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { McpRuntime } from '../src/runtime'
import { createInMemoryRuntimeCaller } from '../src/runtime-caller'
import { openRuntimeStores } from '../src/runtime-stores'

describe('MCP Runtime', () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(
			roots.splice(0).map((root) => fs.rm(root, { recursive: true })),
		)
	})

	it('returns a secret-free registry snapshot through the caller seam', async () => {
		const runtime = new McpRuntime(
			await storesFor({
				url: 'http://127.0.0.1:1/mcp',
				headers: { 'x-api-key': 'secret' },
				auth: { kind: 'none' },
			}),
		)
		const caller = createInMemoryRuntimeCaller('snapshot')

		await runtime.handle(
			{ requestId: 'snapshot', op: 'registrySnapshot' },
			caller,
		)

		expect(caller.frames[0]).toMatchObject({
			requestId: 'snapshot',
			kind: 'result',
		})
		expect(JSON.stringify(caller.frames)).not.toContain('secret')
	})

	it('returns reauth-required without attempting an ordinary OAuth flow', async () => {
		const runtime = new McpRuntime(
			await storesFor({
				url: 'http://127.0.0.1:1/mcp',
				auth: {
					kind: 'oauth-token',
					tokenKey: 'fixture:http://127.0.0.1:1',
					confidence: 'confirmed',
				},
			}),
		)
		const caller = createInMemoryRuntimeCaller('call')

		await runtime.handle(
			{
				requestId: 'call',
				op: 'call',
				serverName: 'fixture',
				toolName: 'echo',
				input: {},
			},
			caller,
		)

		expect(caller.frames).toEqual([
			{
				requestId: 'call',
				kind: 'error',
				error: {
					code: 'reauth-required',
					message: 'Credentials for fixture must be refreshed.',
				},
			},
		])
	})

	async function storesFor(server: Record<string, unknown>) {
		const root = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-runtime-'))
		roots.push(root)
		await fs.writeFile(
			path.join(root, 'servers.json'),
			JSON.stringify({ version: 1, servers: { fixture: server } }),
		)
		return openRuntimeStores(root)
	}
})
