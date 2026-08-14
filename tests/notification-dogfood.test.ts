import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

const mainPath = path.join(import.meta.dir, '..', 'src', 'main.ts')
const fixturePath = path.join(
	import.meta.dir,
	'fixtures',
	'notification-mcp-server.mjs',
)
const rawContext = ['--context', "{ output: 'raw' }"]

let home: string

describe('notification fixture dogfood', () => {
	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(tmpdir(), 'mcpx-notification-dogfood-'))
	})

	afterEach(async () => {
		await runMcpx(['@daemon.stop']).catch(() => {})
		await fs.rm(home, { recursive: true, force: true })
	})

	it('covers notification rendering, schema write-back, and daemon status through the CLI', async () => {
		const added = await runMcpx([
			'@add',
			'--name',
			'notification-fixture',
			'--transport',
			'stdio',
			'--command',
			process.execPath,
			'--args',
			fixturePath,
			...rawContext,
		])
		expect(JSON.parse(added.stdout)).toMatchObject({
			name: 'notification-fixture',
			transport: 'stdio',
			status: 'ready',
			tools: 5,
		})

		const progress = parseMcpxOutput(
			(await runMcpx(['notification-fixture.progress-stream', '--count', '4']))
				.stdout,
		)
		expect(progress.text).toBe('progress-stream-ok')
		expect(progress.structured).toEqual({
			tool: 'progress-stream',
			count: 4,
		})
		expect(progress.notification).toEqual([
			{
				method: 'notifications/progress',
				params: expect.objectContaining({
					progress: 1,
					total: 4,
					message: 'step 1',
				}),
			},
			{
				method: 'notifications/progress',
				params: expect.objectContaining({
					progress: 4,
					total: 4,
					message: 'step 4',
				}),
				aggregatedCount: 2,
			},
		])

		const progressRaw = parseMcpxOutput(
			(
				await runMcpx([
					'notification-fixture.progress-stream',
					'--count',
					'4',
					...rawContext,
				])
			).stdout,
		)
		expect(progressRaw.text).toBe('progress-stream-ok')
		expect(progressRaw.structured).toEqual({
			tool: 'progress-stream',
			count: 4,
		})
		expect(progressRaw.notification).toEqual([
			{
				method: 'notifications/progress',
				params: expect.objectContaining({
					progress: 1,
					total: 4,
					message: 'step 1',
				}),
			},
			{
				method: 'notifications/progress',
				params: expect.objectContaining({
					progress: 4,
					total: 4,
					message: 'step 4',
				}),
				aggregatedCount: 2,
			},
		])

		const discardedRaw = parseMcpxOutput(
			(
				await runMcpx(
					[
						'notification-fixture.progress-stream',
						'--count',
						'4',
						...rawContext,
					],
					{ MCPX_NOTIFICATION_MODE: 'discard' },
				)
			).stdout,
		)
		expect(discardedRaw).toEqual({
			text: 'progress-stream-ok',
			structured: { tool: 'progress-stream', count: 4 },
			notification: undefined,
		})

		const toolsChanged = parseMcpxOutput(
			(
				await runMcpx([
					'notification-fixture.notify-tools-changed',
					...rawContext,
				])
			).stdout,
		)
		expect(toolsChanged.notification).toContainEqual({
			method: 'notifications/tools/list_changed',
		})

		const verbatim = parseMcpxOutput(
			(await runMcpx(['notification-fixture.verbatim-notify', ...rawContext]))
				.stdout,
		)
		expect(verbatim.notification).toEqual([
			{
				method: 'notifications/custom/event',
				params: { source: 'notification-fixture', ok: true },
			},
		])

		const flood = parseMcpxOutput(
			(await runMcpx(['notification-fixture.flood-notify'])).stdout,
		)
		expect(flood.text).toBe('flood-notify-ok')
		expect(flood.structured).toEqual({ tool: 'flood-notify' })
		const oversizeMessage = String(flood.notification)
		expect(oversizeMessage).toMatch(
			/^notifications oversize, saved to .+mcpx-notifications-.+\.json$/,
		)
		const savedTo = oversizeMessage.replace(
			'notifications oversize, saved to ',
			'',
		)
		const savedNotifications = JSON.parse(await fs.readFile(savedTo, 'utf8'))
		expect(savedNotifications).toHaveLength(120)
		expect(savedNotifications[0]).toMatchObject({
			method: 'notifications/custom/flood',
			params: { index: 0 },
		})

		const beforeIdle = await readRegisteredServerDiscoveredAt()
		await runMcpx(['notification-fixture.idle-tools-changed', ...rawContext])
		await sleep(75)
		await runMcpx([
			'notification-fixture.progress-stream',
			'--count',
			'0',
			...rawContext,
		])
		const afterIdle = await readRegisteredServerDiscoveredAt()
		expect(afterIdle).not.toBe(beforeIdle)

		const status = JSON.parse(
			(await runMcpx(['@daemon.status', ...rawContext])).stdout,
		)
		expect(status.servers).toContainEqual(
			expect.objectContaining({
				transport: 'stdio',
				labels: ['notification-fixture'],
				activeCalls: 0,
				queuedCalls: 0,
				evictCount: 0,
				hasRetainedSessionId: false,
			}),
		)

		const removed = JSON.parse(
			(
				await runMcpx([
					'@remove',
					'--name',
					'notification-fixture',
					...rawContext,
				])
			).stdout,
		)
		expect(removed).toEqual({
			name: 'notification-fixture',
			removed: true,
			tokenRemoved: false,
		})
		const registry = JSON.parse(
			await fs.readFile(
				path.join(home, '.agents', 'mcpx', 'state-v2', 'registry.json'),
				'utf8',
			),
		)
		expect(registry.servers).toEqual({})
	})
})

function parseMcpxOutput(stdout: string): {
	text: string
	structured: unknown
	notification: unknown
} {
	const notificationMarker = '\n$notification: '
	const notificationIndex = stdout.indexOf(notificationMarker)
	const beforeNotification =
		notificationIndex === -1 ? stdout : stdout.slice(0, notificationIndex)
	const notification =
		notificationIndex === -1
			? undefined
			: JSON.parse(stdout.slice(notificationIndex + notificationMarker.length))

	const structuredMarker = '\n$structured:'
	const structuredIndex = beforeNotification.indexOf(structuredMarker)
	if (structuredIndex === -1) {
		return { text: beforeNotification, structured: undefined, notification }
	}

	const text = beforeNotification.slice(0, structuredIndex)
	const structured = parseYaml(
		beforeNotification.slice(structuredIndex + 1),
	) as { $structured: unknown }

	return { text, structured: structured.$structured, notification }
}

async function runMcpx(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, mainPath, ...args], {
		env: {
			...process.env,
			HOME: home,
			MCPX_HOME: home,
			...env,
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	if (exitCode !== 0) {
		throw new Error(
			`mcpx ${args.join(' ')} failed with ${exitCode}\n${stderr}\n${stdout}`,
		)
	}
	return { stdout: stdout.trim(), stderr: stderr.trim() }
}

async function readRegisteredServerDiscoveredAt(): Promise<string | undefined> {
	const raw = await fs.readFile(
		path.join(home, '.agents', 'mcpx', 'state-v2', 'schema-cache.json'),
		'utf8',
	)
	return JSON.parse(raw).servers['notification-fixture'].discoveredAt
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}
