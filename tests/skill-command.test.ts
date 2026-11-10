import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RegistryView } from '../src/skill-command'

import { runSkillCommand } from '../src/skill-command'

function fixtureService(): RegistryView {
	return {
		servers: {
			slack: {
				transport: 'stdio',
				command: 'slack-mcp',
				env: { SLACK_BOT_TOKEN: 'xoxb-secret' },
				tools: [],
			},
			posthog: {
				url: 'https://mcp.posthog.com/mcp',
				auth: {
					kind: 'bearer',
					credentials: [{ kind: 'env', name: 'POSTHOG_TOKEN' }],
					strategy: 'round-robin',
					confidence: 'configured',
				},
				tools: [],
			},
		},
	}
}

describe('mcpx skill command', () => {
	it('prints a temporary server skill without writing project files', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'mcpx-skill-show-'))
		const output = await runSkillCommand(fixtureService(), cwd, {
			show: 'slack',
		})

		expect(output).toContain('servers: ["slack"]')
		expect(output).toContain('configured MCP servers')
		expect(output).toContain("mcpx @schema '.slack'")
		await expect(
			readFile(join(cwd, '.agents', 'skills', 'mcpx', 'SKILL.md'), 'utf8'),
		).rejects.toThrow()
	})

	it('writes project skill references from registry declarations', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'mcpx-skill-write-'))
		const output = await runSkillCommand(fixtureService(), cwd, {
			servers: 'posthog,slack',
		})

		const skillDir = join(cwd, '.agents', 'skills', 'mcpx')
		expect(output).toContain(`Wrote ${skillDir}`)
		const skill = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
		const servers = await readFile(
			join(skillDir, 'references', 'servers.md'),
			'utf8',
		)
		expect(skill).toContain('## Troubleshooting')
		expect(servers).toContain(
			`mcpx @add '{"name":"posthog","url":"https://mcp.posthog.com/mcp","bearer":"env:POSTHOG_TOKEN"}'`,
		)
		expect(servers).toContain(
			`mcpx @add '{"name":"slack","transport":"stdio","command":"slack-mcp"}'`,
		)
		expect(servers).not.toContain('xoxb-secret')
	})

	it('rejects mixing temporary show and project skill generation', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'mcpx-skill-show-'))

		await expect(
			runSkillCommand(fixtureService(), cwd, {
				servers: 'slack',
				show: 'slack',
			}),
		).rejects.toThrow('--show cannot be combined with --servers.')
	})
})
