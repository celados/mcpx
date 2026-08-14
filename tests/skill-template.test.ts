import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	buildAddCommand,
	buildInstallReferenceMarkdown,
	buildMcpxSkillMarkdown,
	buildSchemaSelector,
	buildServersReferenceMarkdown,
	parseMcpxSkillServers,
	writeMcpxSkill,
} from '../src/skill-template'

describe('mcpx skill template', () => {
	it('builds argc schema selectors for selected servers', () => {
		expect(buildSchemaSelector(['posthog'])).toBe('.posthog')
		expect(buildSchemaSelector(['posthog', 'sentry'])).toBe('.{posthog,sentry}')
		expect(buildSchemaSelector(['cf-docs'])).toBe('."cf-docs"')
		expect(buildSchemaSelector(['cf-docs', 'sentry'])).toBe(
			'.{"cf-docs",sentry}',
		)
	})

	it('writes a project-local mcpx skill with troubleshooting references', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'mcpx-skill-'))
		const skillDir = await writeMcpxSkill({
			cwd,
			servers: ['posthog', 'sentry'],
			declarations: {
				posthog: {
					url: 'https://mcp.posthog.com/mcp',
					auth: {
						kind: 'bearer',
						credentials: [{ kind: 'env', name: 'POSTHOG_TOKEN' }],
					},
				},
				sentry: {
					url: 'https://mcp.sentry.dev/mcp',
					auth: { kind: 'oauth' },
				},
			},
		})
		const content = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
		const install = await readFile(
			join(skillDir, 'references', 'install.md'),
			'utf8',
		)
		const servers = await readFile(
			join(skillDir, 'references', 'servers.md'),
			'utf8',
		)

		expect(skillDir).toBe(join(cwd, '.agents', 'skills', 'mcpx'))
		expect(content).toContain('name: "mcpx"')
		expect(content).toContain('servers: ["posthog", "sentry"]')
		expect(content).toContain(
			'description: "Use project-approved MCP tools through mcpx. Trigger when the user asks to inspect or operate services backed by these MCP servers: posthog, sentry."',
		)
		expect(content).toContain("mcpx @schema '.{posthog,sentry}'")
		expect(content).toContain('`.server.{tool-a,tool-b,tool-c}`')
		expect(content).toContain(
			`mcpx @schema '.posthog.{"projects-get","alerts-list","alert-create"}'`,
		)
		expect(content).toContain("mcpx <server>.<tool> '{ }'")
		expect(content).toContain('mcpx <server>.<tool> @payload.json')
		expect(content).toContain("mcpx <server>.<tool> - <<'JSON'")
		expect(content).toContain('## Troubleshooting')
		expect(content).toContain('references/install.md')
		expect(content).toContain('references/servers.md')
		expect(install).toBe(buildInstallReferenceMarkdown())
		expect(install).toContain(
			'https://raw.githubusercontent.com/celados/mcpx/main/install.sh',
		)
		expect(servers).toContain(
			`mcpx @add '{"name":"posthog","url":"https://mcp.posthog.com/mcp","bearer":"env:POSTHOG_TOKEN"}'`,
		)
		expect(servers).toContain(
			`mcpx @add '{"name":"sentry","url":"https://mcp.sentry.dev/mcp"}'`,
		)
		expect(servers).toContain('mcpx @refresh')
	})

	it('builds temporary mcpx skill markdown without project-local wording', () => {
		const content = buildMcpxSkillMarkdown(['slack'], { projectLocal: false })

		expect(content).toContain('servers: ["slack"]')
		expect(content).toContain('configured MCP servers')
		expect(content).not.toContain('project-approved MCP servers')
		expect(content).toContain("mcpx @schema '.slack'")
		expect(content).not.toContain('## Troubleshooting')
		expect(content).not.toContain('references/install.md')
	})

	it('redacts secret bearer values from generated add recipes', () => {
		const servers = buildServersReferenceMarkdown(['posthog'], {
			posthog: {
				url: 'https://mcp.posthog.com/mcp',
				auth: {
					kind: 'bearer',
					credentials: [
						{ kind: 'literal', value: 'sk-super-secret' },
						{ kind: 'stored', key: 'posthog:bearer:0' },
					],
				},
			},
		})

		expect(servers).toContain(
			`mcpx @add '{"name":"posthog","url":"https://mcp.posthog.com/mcp"}'`,
		)
		expect(servers).not.toContain('sk-super-secret')
		expect(servers).not.toContain('posthog:bearer:0')
		expect(servers).toContain(
			'This server requires a bearer token that was not stored as an environment reference.',
		)
	})

	it('omits stdio env values and flags machine-local paths', () => {
		const servers = buildServersReferenceMarkdown(['open-design'], {
			'open-design': {
				transport: 'stdio',
				command: 'node',
				args: ['/Users/dio/open-design/cli.js', 'mcp'],
				env: { OPEN_DESIGN_TOKEN: 'super-secret-env' },
			} as {
				transport: 'stdio'
				command: string
				args: string[]
				env: Record<string, string>
			},
		})

		expect(servers).toContain(
			`mcpx @add '{"name":"open-design","transport":"stdio","command":"node","args":["/Users/dio/open-design/cli.js","mcp"]}'`,
		)
		expect(servers).toContain('machine-local paths')
		expect(servers).not.toContain('super-secret-env')
	})

	it('quotes unsafe shell characters in add recipes', () => {
		expect(
			buildAddCommand('docs', {
				url: 'https://example.test/mcp?x=1&y=2',
			}),
		).toBe(
			`mcpx @add '{"name":"docs","url":"https://example.test/mcp?x=1&y=2"}'`,
		)
	})

	it('falls back when a selected server has no declaration', () => {
		const servers = buildServersReferenceMarkdown(['custom'])
		expect(servers).toContain('### custom')
		expect(servers).toContain('No stored `@add` recipe')
	})

	it('parses selected servers from existing skill frontmatter', () => {
		expect(
			parseMcpxSkillServers(`---
name: mcpx
servers: [posthog, sentry]
description: Example
---

# MCPX
`),
		).toEqual(['posthog', 'sentry'])
		expect(
			parseMcpxSkillServers(`---
name: "mcpx"
servers:
  - posthog
  - sentry
description: "Example: valid YAML"
---

# MCPX
`),
		).toEqual(['posthog', 'sentry'])
		expect(
			parseMcpxSkillServers(`---
name: "mcpx"
servers: ["posthog", 1, "", "sentry"]
description: "Example: mixed YAML"
---

# MCPX
`),
		).toEqual(['posthog', 'sentry'])
		expect(
			parseMcpxSkillServers(`---
name: mcpx
servers: [posthog]
description: Invalid YAML: because this unquoted scalar contains a mapping
---

# MCPX
`),
		).toEqual([])
	})
})
