import { describe, expect, it } from 'bun:test'
import { parse as parseYaml } from 'yaml'

import { formatMcpContent, renderOutput } from '../src/output'

describe('output format', () => {
	it('returns text MCP content directly by default', async () => {
		await expect(
			renderOutput(
				{ content: [{ type: 'text', text: 'ok' }] },
				{ output: 'optimized' },
			),
		).resolves.toBe('ok\n')
	})

	it('renders JSON text MCP content as YAML by default', async () => {
		await expect(
			formatMcpContent([{ type: 'text', text: '{"name":"Ada","age":30}' }]),
		).resolves.toEqual(['name: Ada\nage: 30'])
	})

	it('preserves JSON text MCP content in raw mode', async () => {
		await expect(
			renderOutput(
				{ content: [{ type: 'text', text: '{"name":"Ada","age":30}' }] },
				{ output: 'raw' },
			),
		).resolves.toBe('{"name":"Ada","age":30}\n')
	})

	it('maps MCP error content to a stable domain error', async () => {
		await expect(
			renderOutput(
				{ content: [{ type: 'text', text: 'failed' }], isError: true },
				{ output: 'optimized' },
			),
		).rejects.toMatchObject({
			envelope: {
				error: 'DOMAIN_ERROR',
				code: 'MCP_TOOL_ERROR',
				detail: 'failed',
			},
		})
	})

	it('returns text before supplemental structured content', async () => {
		const output = await renderOutput(
			{
				content: [{ type: 'text', text: 'human' }],
				structuredContent: { pages: [{ pageId: 1 }], count: 1 },
			},
			{ output: 'optimized' },
		)

		expect(output).toBe(
			'human\n$structured:\n  pages:\n    - pageId: 1\n  count: 1\n',
		)
	})

	it('does not repeat structured content represented by JSON text', async () => {
		const output = await renderOutput(
			{
				content: [{ type: 'text', text: '{"pages":[{"pageId":1}],"count":1}' }],
				structuredContent: { pages: [{ pageId: 1 }], count: 1 },
			},
			{ output: 'optimized' },
		)

		expect(parseYaml(output ?? '')).toEqual({
			pages: [{ pageId: 1 }],
			count: 1,
		})
	})

	it('keeps result metadata in raw structured output', async () => {
		const output = await renderOutput(
			{
				structuredContent: { count: 1 },
				_meta: { traceId: 'abc' },
			},
			{ output: 'raw' },
		)

		expect(JSON.parse(output ?? '')).toEqual({
			structuredContent: { count: 1 },
			_meta: { traceId: 'abc' },
		})
	})

	it('appends raw structured content after raw primary text', async () => {
		await expect(
			renderOutput(
				{
					content: [{ type: 'text', text: '{"name":"Ada"}' }],
					structuredContent: { count: 1 },
				},
				{ output: 'raw' },
			),
		).resolves.toBe('{"name":"Ada"}\n$structured: {"count":1}\n')
	})

	it('renders ordinary values as raw JSON in raw mode', async () => {
		await expect(
			renderOutput({ name: 'Ada' }, { output: 'raw' }),
		).resolves.toBe('{\n  "name": "Ada"\n}\n')
	})

	it('appends notification sentinels to text daemon results', async () => {
		await expect(
			renderOutput(
				{
					__mcpxDaemonResponse: true,
					result: { content: [{ type: 'text', text: 'ok' }] },
					notifications: [{ method: 'notifications/tools/list_changed' }],
				},
				{ output: 'optimized' },
			),
		).resolves.toBe(
			'ok\n$notification: [{"method":"notifications/tools/list_changed"}]\n',
		)
	})

	it('merges daemon notifications into optimized object output', async () => {
		const output = await renderOutput(
			{
				__mcpxDaemonResponse: true,
				result: { structuredContent: { count: 1 } },
				notifications: [{ method: 'notifications/tools/list_changed' }],
			},
			{ output: 'optimized' },
		)

		expect(parseYaml(output ?? '')).toEqual({
			count: 1,
			$notifications: [{ method: 'notifications/tools/list_changed' }],
		})
	})

	it('wraps raw structured daemon results with notifications', async () => {
		const output = await renderOutput(
			{
				__mcpxDaemonResponse: true,
				result: { structuredContent: { count: 1 } },
				notifications: [{ method: 'notifications/tools/list_changed' }],
			},
			{ output: 'raw' },
		)

		expect(JSON.parse(output ?? '')).toEqual({
			result: { structuredContent: { count: 1 } },
			notifications: [{ method: 'notifications/tools/list_changed' }],
		})
	})

	it('saves non-text MCP content to a temp file', async () => {
		const [line] = await formatMcpContent([
			{
				type: 'image',
				mimeType: 'image/png',
				data: Buffer.from('png').toString('base64'),
			},
		])

		expect(line).toMatch(/^file saved .+\/mcpx-[a-f0-9]+\.png$/)
	})

	it('formats embedded text resources as text', async () => {
		await expect(
			formatMcpContent([
				{
					type: 'resource',
					resource: {
						uri: 'file:///tmp/data.json',
						mimeType: 'application/json',
						text: '{"ok":true}',
					},
				},
			]),
		).resolves.toEqual(['ok: true'])
	})

	it('renders resource links as metadata', async () => {
		const [line] = await formatMcpContent([
			{
				type: 'resource_link',
				uri: 'file:///tmp/report.md',
				name: 'report',
				mimeType: 'text/markdown',
			},
		])

		expect(parseYaml(line ?? '')).toEqual({
			type: 'resource_link',
			uri: 'file:///tmp/report.md',
			name: 'report',
			mimeType: 'text/markdown',
		})
	})
})
