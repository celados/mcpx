import { describe, expect, it } from 'bun:test'
import { parse as parseYaml } from 'yaml'

import { formatMcpContent, printOutput } from '../src/output'
import { __test } from '../src/router'

describe('output format', () => {
	it('prints text MCP content directly by default', async () => {
		const log = captureConsoleLog()
		try {
			await printOutput(
				{ content: [{ type: 'text', text: 'ok' }] },
				{ output: 'yaml' },
			)

			expect(log.calls[0]?.[0]).toBe('ok')
		} finally {
			log.restore()
		}
	})

	it('prints JSON text MCP content as YAML by default', async () => {
		await expect(
			formatMcpContent([{ type: 'text', text: '{"name":"Ada","age":30}' }]),
		).resolves.toEqual(['name: Ada\nage: 30'])
	})

	it('prints JSON text MCP content as raw text when --raw is selected', async () => {
		const log = captureConsoleLog()
		try {
			await printOutput(
				{ content: [{ type: 'text', text: '{"name":"Ada","age":30}' }] },
				{ output: 'raw' },
			)

			expect(log.calls[0]?.[0]).toBe('{"name":"Ada","age":30}')
		} finally {
			log.restore()
		}
	})

	it('prints MCP error content to stderr and marks the process as failed', async () => {
		const log = captureConsoleLog()
		const error = captureConsoleError()
		const previousExitCode = process.exitCode
		process.exitCode = undefined
		try {
			await printOutput(
				{ content: [{ type: 'text', text: 'failed' }], isError: true },
				{ output: 'yaml' },
			)

			expect(log.calls).toEqual([])
			expect(error.calls[0]?.[0]).toBe('failed')
			expect(Number(process.exitCode)).toBe(1)
		} finally {
			log.restore()
			error.restore()
			process.exitCode = previousExitCode ?? 0
		}
	})

	it('prints text MCP content before supplemental structured content', async () => {
		const log = captureConsoleLog()
		try {
			await printOutput(
				{
					content: [{ type: 'text', text: 'human' }],
					structuredContent: { pages: [{ pageId: 1 }], count: 1 },
				},
				{ output: 'yaml' },
			)

			expect(log.calls[0]?.[0]).toBe('human')
			expect(parseYaml(String(log.calls[1]?.[0]))).toEqual({
				$structured: {
					pages: [{ pageId: 1 }],
					count: 1,
				},
			})
		} finally {
			log.restore()
		}
	})

	it('does not repeat structured MCP content already represented by JSON text', async () => {
		const log = captureConsoleLog()
		try {
			await printOutput(
				{
					content: [
						{
							type: 'text',
							text: '{"pages":[{"pageId":1}],"count":1}',
						},
					],
					structuredContent: { pages: [{ pageId: 1 }], count: 1 },
				},
				{ output: 'yaml' },
			)

			expect(log.calls).toHaveLength(1)
			expect(parseYaml(String(log.calls[0]?.[0]))).toEqual({
				pages: [{ pageId: 1 }],
				count: 1,
			})
		} finally {
			log.restore()
		}
	})

	it('keeps result metadata available in raw structured output', async () => {
		const log = captureConsoleLog()
		try {
			await printOutput(
				{
					structuredContent: { count: 1 },
					_meta: { traceId: 'abc' },
				},
				{ output: 'raw' },
			)

			expect(log.calls[0]?.[0]).toBe(
				'{\n  "structuredContent": {\n    "count": 1\n  },\n  "_meta": {\n    "traceId": "abc"\n  }\n}',
			)
		} finally {
			log.restore()
		}
	})

	it('keeps raw text primary and appends raw structured content when both exist', async () => {
		const log = captureConsoleLog()
		try {
			await printOutput(
				{
					content: [{ type: 'text', text: '{"name":"Ada"}' }],
					structuredContent: { count: 1 },
				},
				{ output: 'raw' },
			)

			expect(log.calls.map((call) => call[0])).toEqual([
				'{"name":"Ada"}',
				'$structured: {"count":1}',
			])
		} finally {
			log.restore()
		}
	})

	it('prints structured-looking text MCP content as raw text when --raw is selected', async () => {
		await expect(
			formatMcpContent(
				[{ type: 'text', text: '"0":\n  id: 1\n  name: Drawout' }],
				'raw',
			),
		).resolves.toEqual(['"0":\n  id: 1\n  name: Drawout'])
	})

	it('prints non-MCP values as raw JSON when --raw is selected', async () => {
		const log = captureConsoleLog()
		try {
			await printOutput({ name: 'Ada' }, { output: 'raw' })

			expect(log.calls[0]?.[0]).toBe('{\n  "name": "Ada"\n}')
		} finally {
			log.restore()
		}
	})

	it('appends notification sentinel for daemon results by default', async () => {
		const log = captureConsoleLog()
		try {
			await printOutput(
				{
					__mcpxDaemonResponse: true,
					result: { content: [{ type: 'text', text: 'ok' }] },
					notifications: [{ method: 'notifications/tools/list_changed' }],
				},
				{ output: 'yaml' },
			)

			expect(log.calls.map((call) => call[0])).toEqual([
				'ok',
				'$notification: [{"method":"notifications/tools/list_changed"}]',
			])
		} finally {
			log.restore()
		}
	})

	it('merges structured daemon notifications into the default YAML object', async () => {
		const log = captureConsoleLog()
		try {
			await printOutput(
				{
					__mcpxDaemonResponse: true,
					result: { structuredContent: { count: 1 } },
					notifications: [{ method: 'notifications/tools/list_changed' }],
				},
				{ output: 'yaml' },
			)

			expect(parseYaml(String(log.calls[0]?.[0]))).toEqual({
				count: 1,
				$notifications: [{ method: 'notifications/tools/list_changed' }],
			})
		} finally {
			log.restore()
		}
	})

	it('merges JSON text daemon notifications into the default YAML object', async () => {
		const log = captureConsoleLog()
		try {
			await printOutput(
				{
					__mcpxDaemonResponse: true,
					result: { content: [{ type: 'text', text: '{"count":1}' }] },
					notifications: [
						{ method: 'notifications/custom/event', params: { ok: true } },
					],
				},
				{ output: 'yaml' },
			)

			expect(parseYaml(String(log.calls[0]?.[0]))).toEqual({
				count: 1,
				$notifications: [
					{ method: 'notifications/custom/event', params: { ok: true } },
				],
			})
		} finally {
			log.restore()
		}
	})

	it('renders oversize notifications as a saved-file message in default YAML output', async () => {
		const log = captureConsoleLog()
		try {
			await printOutput(
				{
					__mcpxDaemonResponse: true,
					result: { structuredContent: { count: 1 } },
					notifications: [
						{
							method: '$oversize',
							params: { savedTo: '/tmp/mcpx-notifications-a.json' },
						},
					],
				},
				{ output: 'yaml' },
			)

			expect(parseYaml(String(log.calls[0]?.[0]))).toEqual({
				count: 1,
				$notifications:
					'notifications oversize, saved to /tmp/mcpx-notifications-a.json',
			})
		} finally {
			log.restore()
		}
	})

	it('wraps raw structured daemon results when notifications are present', async () => {
		const log = captureConsoleLog()
		try {
			await printOutput(
				{
					__mcpxDaemonResponse: true,
					result: { structuredContent: { count: 1 } },
					notifications: [{ method: 'notifications/tools/list_changed' }],
				},
				{ output: 'raw' },
			)

			expect(JSON.parse(String(log.calls[0]?.[0]))).toEqual({
				result: { structuredContent: { count: 1 } },
				notifications: [{ method: 'notifications/tools/list_changed' }],
			})
		} finally {
			log.restore()
		}
	})

	it('keeps --raw from consuming the following command segment', () => {
		expect(
			__test.normalizeArgv([
				'--raw',
				'posthog',
				'docs-search',
				'--input',
				'{}',
			]),
		).toEqual(['posthog', 'docs-search', '--input', '{}', '--raw'])
	})

	it('rejects the old --json flag', () => {
		expect(
			__test.normalizeArgv(['posthog', 'docs-search', '--json']),
		).toBeNull()
		expect(
			__test.normalizeArgv(['posthog', 'docs-search', '--json=true']),
		).toBeNull()
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

	it('saves embedded binary resources using the resource mime type', async () => {
		const [line] = await formatMcpContent([
			{
				type: 'resource',
				resource: {
					uri: 'file:///tmp/sound.wav',
					mimeType: 'audio/wav',
					blob: Buffer.from('wav').toString('base64'),
				},
			},
		])

		expect(line).toMatch(/^file saved .+\/mcpx-[a-f0-9]+\.wav$/)
	})

	it('prints resource links as metadata instead of saving fake binary content', async () => {
		const [line] = await formatMcpContent([
			{
				type: 'resource_link',
				uri: 'file:///tmp/report.md',
				name: 'report',
				mimeType: 'text/markdown',
			},
		])

		if (line === undefined)
			throw new Error('Expected one resource link output line.')
		expect(parseYaml(line)).toEqual({
			type: 'resource_link',
			uri: 'file:///tmp/report.md',
			name: 'report',
			mimeType: 'text/markdown',
		})
	})
})

function captureConsoleLog(): {
	calls: unknown[][]
	restore: () => void
} {
	const original = process.stdout.write
	const calls: unknown[][] = []
	process.stdout.write = ((
		chunk: string | Uint8Array,
		callback?: () => void,
	) => {
		calls.push([String(chunk).replace(/\n$/, '')])
		callback?.()
		return true
	}) as typeof process.stdout.write
	return {
		calls,
		restore: () => {
			process.stdout.write = original
		},
	}
}

function captureConsoleError(): {
	calls: unknown[][]
	restore: () => void
} {
	const original = process.stderr.write
	const calls: unknown[][] = []
	process.stderr.write = ((
		chunk: string | Uint8Array,
		callback?: () => void,
	) => {
		calls.push([String(chunk).replace(/\n$/, '')])
		callback?.()
		return true
	}) as typeof process.stderr.write
	return {
		calls,
		restore: () => {
			process.stderr.write = original
		},
	}
}
