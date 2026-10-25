import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { RuntimeFrame } from '../src/runtime-protocol'

import { discoverServer } from '../src/discovery'
import { authorizationChallenge, connectMcpClient } from '../src/mcp-client'
import { McpRuntime } from '../src/runtime'
import { RuntimeAuthentication } from '../src/runtime-authentication'
import { createInMemoryRuntimeCaller } from '../src/runtime-caller'
import { openRuntimeStores } from '../src/runtime-stores'

// A mixed-auth server like whiteboardanimation.ai: `quote` is anonymous,
// `status` answers 401 with a resource_metadata challenge until authorized.
describe('OAuth discovered from a call-time challenge', () => {
	const roots: string[] = []
	const fixtures: Bun.Server<unknown>[] = []

	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) fixture.stop(true)
		await Promise.all(
			roots.splice(0).map((root) => fs.rm(root, { recursive: true })),
		)
	})

	it('surfaces the 401 challenge from the transport', async () => {
		const fixture = serveMixedAuthServer()
		const connection = await connectMcpClient({
			url: fixture.url,
			auth: { kind: 'none' },
		})
		try {
			const error = await connection.client
				.callTool({ name: 'status', arguments: {} })
				.catch((caught: unknown) => caught)

			expect(authorizationChallenge(error)).toEqual({
				status: 401,
				resourceMetadataUrl: fixture.resourceMetadataUrl,
				scope: 'mcp:tools',
			})
		} finally {
			await connection.close()
		}
	})

	it('surfaces a 403 insufficient_scope challenge from the transport', async () => {
		const fixture = serveMixedAuthServer({ insufficientScope: true })
		const connection = await connectMcpClient(
			{ url: fixture.url, auth: { kind: 'none' } },
			{ token: 'narrow-token' },
		)
		try {
			const error = await connection.client
				.callTool({ name: 'status', arguments: {} })
				.catch((caught: unknown) => caught)

			expect(authorizationChallenge(error)).toMatchObject({
				status: 403,
				scope: 'mcp:tools mcp:admin',
			})
		} finally {
			await connection.close()
		}
	})

	it('adds a mixed-auth server without auth and an OAuth-only one as OAuth', async () => {
		const mixed = serveMixedAuthServer()
		const protectedOnly = serveMixedAuthServer({ protectAll: true })

		const added = await discoverServer({ name: 'wb', url: mixed.url })
		const challenged = await discoverServer({
			name: 'locked',
			url: protectedOnly.url,
		})

		expect(added).toMatchObject({
			status: 'ready',
			server: { auth: { kind: 'none' } },
		})
		expect(challenged).toMatchObject({
			status: 'auth-required',
			server: { auth: { kind: 'oauth' } },
		})
	})

	it('authorizes in the browser when a Call is challenged, then retries it', async () => {
		const fixture = serveMixedAuthServer()
		const root = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-challenge-'))
		roots.push(root)
		const stores = await openRuntimeStores(root)
		await stores.upsertServer('wb', {
			url: fixture.url,
			auth: { kind: 'none' },
		})
		const browserUrls: string[] = []
		const runtime = new McpRuntime(stores, {
			authentication: new RuntimeAuthentication(stores, {
				openBrowser: (url) => {
					browserUrls.push(url)
					void fetch(url).catch(() => {})
				},
			}),
		})

		const quote = createInMemoryRuntimeCaller('quote')
		await runtime.handle(callIntent('quote', 'quote'), quote)
		const status = createInMemoryRuntimeCaller('status')
		await runtime.handle(callIntent('status', 'status'), status)
		const again = createInMemoryRuntimeCaller('again')
		await runtime.handle(callIntent('again', 'status'), again)

		expect(resultText(quote)).toBe('quote-ok')
		expect(resultText(status)).toBe('status-ok')
		expect(resultText(again)).toBe('status-ok')
		// Only the challenged Call opened the browser; the next one reused the grant.
		expect(browserUrls).toHaveLength(1)
		expect(progress(status)).toEqual([
			expect.stringContaining('wb: authorize in your browser'),
		])
		expect(progress(again)).toEqual([])
		const state = await stores.readState()
		expect(state.registry.servers.wb).toMatchObject({ auth: { kind: 'oauth' } })
		expect(state.credentials.oauth.wb?.tokens?.value.access_token).toBe(
			'granted-token',
		)
		await runtime.handle(
			{ requestId: 'stop', op: 'stop' },
			createInMemoryRuntimeCaller('stop'),
		)
	})

	function serveMixedAuthServer(
		options: { protectAll?: boolean; insufficientScope?: boolean } = {},
	) {
		let origin = ''
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			async fetch(request): Promise<Response> {
				const url = new URL(request.url)
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
							registration_endpoint: `${origin}/register`,
							response_types_supported: ['code'],
							code_challenge_methods_supported: ['S256'],
						})
					case '/register': {
						const body = (await request.json()) as Record<string, unknown>
						return Response.json(
							{ ...body, client_id: 'wb-client' },
							{ status: 201 },
						)
					}
					case '/authorize': {
						const redirect = new URL(url.searchParams.get('redirect_uri')!)
						redirect.searchParams.set('code', 'wb-code')
						redirect.searchParams.set('state', url.searchParams.get('state')!)
						return Response.redirect(redirect.toString(), 302)
					}
					case '/token':
						return Response.json({
							access_token: 'granted-token',
							refresh_token: 'granted-refresh',
							token_type: 'Bearer',
							expires_in: 3600,
						})
					case '/mcp':
						return mcp(request)
				}
				return new Response('not found', { status: 404 })
			},
		})
		fixtures.push(server)
		origin = `http://127.0.0.1:${server.port}`
		const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`

		const challenge = () =>
			new Response(JSON.stringify({ error: 'unauthorized' }), {
				status: 401,
				headers: {
					'content-type': 'application/json',
					'www-authenticate': `Bearer scope="mcp:tools", resource_metadata="${resourceMetadataUrl}"`,
				},
			})

		async function mcp(request: Request): Promise<Response> {
			if (request.method !== 'POST') return new Response(null, { status: 405 })
			const authorized =
				request.headers.get('authorization') === 'Bearer granted-token'
			if (options.protectAll && !authorized) return challenge()
			const message = (await request.json()) as {
				id?: number
				method: string
				params?: Record<string, any>
			}
			switch (message.method) {
				case 'initialize':
					return rpc(message.id, {
						protocolVersion: message.params?.protocolVersion,
						capabilities: { tools: {} },
						serverInfo: { name: 'mixed-auth', version: '1.0.0' },
					})
				case 'tools/list':
					return rpc(message.id, {
						tools: [
							{ name: 'quote', inputSchema: { type: 'object' } },
							{ name: 'status', inputSchema: { type: 'object' } },
						],
					})
				case 'tools/call': {
					const name = message.params?.name
					if (name === 'status' && options.insufficientScope)
						return new Response(null, {
							status: 403,
							headers: {
								'www-authenticate': `Bearer error="insufficient_scope", scope="mcp:tools mcp:admin", resource_metadata="${resourceMetadataUrl}"`,
							},
						})
					if (name === 'status' && !authorized) return challenge()
					return rpc(message.id, {
						content: [{ type: 'text', text: `${name}-ok` }],
					})
				}
			}
			return new Response(null, { status: 202 })
		}

		return { url: `${origin}/mcp`, resourceMetadataUrl }
	}
})

function rpc(id: unknown, result: unknown): Response {
	return Response.json({ jsonrpc: '2.0', id, result })
}

function callIntent(requestId: string, toolName: string) {
	return {
		requestId,
		op: 'call' as const,
		serverName: 'wb',
		toolName,
		input: {},
	}
}

function resultText(caller: { frames: RuntimeFrame[] }): string | undefined {
	const frame = caller.frames.find((item) => item.kind !== 'event')
	if (frame?.kind !== 'result') return JSON.stringify(frame)
	const result = (frame.result as { result: { content: { text: string }[] } })
		.result
	return result.content[0]?.text
}

function progress(caller: { frames: RuntimeFrame[] }): string[] {
	return caller.frames.flatMap((frame) =>
		frame.kind === 'event' && frame.event.type === 'progress'
			? [frame.event.message ?? '']
			: [],
	)
}
