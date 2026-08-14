import { YAML } from 'bun'
import fs from 'node:fs/promises'
import path from 'node:path'

export type SkillServerDeclaration = {
	transport?: 'http' | 'stdio'
	url?: string
	command?: string
	args?: string[]
	auth?: {
		kind: string
		credentials?: Array<{
			kind: string
			name?: string
			value?: string
			key?: string
		}>
	}
}

export type SkillTemplateInput = {
	cwd: string
	servers: string[]
	declarations?: Record<string, SkillServerDeclaration>
}

type SkillMarkdownOptions = {
	projectLocal?: boolean
}

export function mcpxSkillDir(cwd: string): string {
	return path.join(cwd, '.agents', 'skills', 'mcpx')
}

export function mcpxSkillPath(cwd: string): string {
	return path.join(mcpxSkillDir(cwd), 'SKILL.md')
}

export function buildSchemaSelector(servers: string[]): string {
	if (servers.length === 0) {
		throw new Error('Select at least one MCP server.')
	}
	if (servers.length === 1) {
		return `.${schemaSelectorKey(servers[0]!)}`
	}
	return `.{${servers.map(schemaSelectorKey).join(',')}}`
}

function schemaSelectorKey(value: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
		? value
		: JSON.stringify(value)
}

export function buildMcpxSkillMarkdown(
	servers: string[],
	options: SkillMarkdownOptions = {},
): string {
	const projectLocal = options.projectLocal ?? true
	const selector = buildSchemaSelector(servers)
	const serverList = servers.map((server) => `- ${server}`).join('\n')
	const description = projectLocal
		? `Use project-approved MCP tools through mcpx. Trigger when the user asks to inspect or operate services backed by these MCP servers: ${servers.join(', ')}.`
		: `Use configured MCP tools through mcpx. Trigger when the user asks to inspect or operate services backed by these MCP servers: ${servers.join(', ')}.`
	const scope = projectLocal ? 'project-approved' : 'configured'
	const troubleshooting = projectLocal ? projectTroubleshootingSection() : ''

	return `---
name: ${JSON.stringify('mcpx')}
servers: [${servers.map((server) => JSON.stringify(server)).join(', ')}]
description: ${JSON.stringify(description)}
---

# MCPX

Use this skill when the task needs one of these ${scope} MCP servers:

${serverList}

## Discover

Inspect the available tool surface before calling tools:

\`\`\`bash
mcpx @schema '${selector}'
\`\`\`

Use schema selectors to narrow large MCP surfaces before choosing a tool:

- \`.server\` shows one server, for example \`mcpx @schema .posthog\`
- \`.server."tool-name"\` shows one kebab-case tool, for example \`mcpx @schema '.posthog."projects-get"'\`
- \`.{a,b}\` selects multiple keys at the current level
- \`.server.{tool-a,tool-b,tool-c}\` shows a short list of candidate tools

Normal workflow: inspect the ${scope} servers first, identify likely
tool names, then follow the schema status line. If the schema says it was fully
output, call the chosen tool directly. If it says only a compact outline was
shown, run a narrower selector such as
\`mcpx @schema '.posthog.{"projects-get","alerts-list","alert-create"}'\`.

## Call

Call MCP tools through dotted command paths and pass one object input token.

\`\`\`bash
mcpx <server>.<tool> '{ }'
\`\`\`

For larger payloads, prefer file or heredoc input:

\`\`\`bash
mcpx <server>.<tool> @payload.json

mcpx <server>.<tool> - <<'JSON'
{
  "example": true
}
JSON
\`\`\`

## Notifications

Most tool calls emit no notifications and this section never applies. When an
MCP server pushes events during a call (progress, schema changes, custom
events), mcpx merges them into default structured output under \`$notifications\`:

\`\`\`yaml
count: 1
$notifications:
  - method: notifications/progress
    params:
      progressToken: "..."
      progress: 3
      total: 4
      message: step 3
\`\`\`

For non-JSON text, binary, or mixed content, mcpx falls back to a trailing
sentinel line:

\`\`\`
<tool result lines>
$notification: [{"method":"notifications/progress","params":{...}}]
\`\`\`

Each entry has \`method\` plus method-specific \`params\`. Special cases:

- \`notifications/progress\` may carry \`aggregatedCount\` on the last entry per progress token, meaning intermediate progress was collapsed (first and last preserved verbatim).
- \`notifications/tools/list_changed\` is handled by mcpx automatically; no agent action required.
- \`$oversize\` appears in raw context when the buffer cap was reached; default output renders it as \`notifications oversize, saved to <path>\`.

In raw context with a structured result and non-empty notifications, the
sentinel line is replaced by a JSON envelope:

\`\`\`json
{ "result": <tool-result>, "notifications": [ ... ] }
\`\`\`

Ignore notifications unless the task specifically depends on progress or
server events. Parse only when \`$notifications\`, the sentinel line, or the raw
envelope is present.

Do not hand-edit MCP configuration in this project. Servers are registered in the user's global mcpx registry.
${troubleshooting}`
}

export function buildInstallReferenceMarkdown(): string {
	return `# Install mcpx

Read this when \`mcpx\` is missing: \`command not found\`, not on \`PATH\`, or
\`mcpx --version\` fails.

## Prerequisites

The released \`mcpx\` binary is a Bun executable. If \`bun\` is missing:

\`\`\`bash
curl -fsSL https://bun.sh/install | bash
\`\`\`

## Install

Install the latest mcpx release:

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/celados/mcpx/main/install.sh | bash
\`\`\`

The installer writes \`~/.local/bin/mcpx\`. If that directory is not on \`PATH\`,
add it for the current session and retry:

\`\`\`bash
export PATH="$HOME/.local/bin:$PATH"
\`\`\`

## Verify

\`\`\`bash
command -v mcpx
mcpx --version
\`\`\`

Once \`mcpx\` runs, return to the skill. If a listed server is still missing,
read [servers.md](servers.md).
`
}

export function buildAddCommand(
	name: string,
	declaration: SkillServerDeclaration,
): string | undefined {
	if (declaration.transport === 'stdio') {
		if (!declaration.command) return undefined
		const input: Record<string, unknown> = {
			name,
			transport: 'stdio',
			command: declaration.command,
		}
		if (declaration.args?.length) input.args = declaration.args
		return `mcpx @add ${shellQuote(JSON.stringify(input))}`
	}

	if (!declaration.url) return undefined
	const input: Record<string, unknown> = { name, url: declaration.url }
	// Only env:NAME is safe to commit. Literal/stored bearer values stay in the
	// credential store and are surfaced as a "ask the user" note instead.
	const bearer = bearerEnvNames(declaration).map((envName) => `env:${envName}`)
	if (bearer.length === 1) input.bearer = bearer[0]
	if (bearer.length > 1) input.bearer = bearer
	return `mcpx @add ${shellQuote(JSON.stringify(input))}`
}

export function buildServersReferenceMarkdown(
	servers: string[],
	declarations: Record<string, SkillServerDeclaration> = {},
): string {
	const sections = servers.map((name) =>
		renderServerSection(name, declarations[name]),
	)

	// Collaborators only see server names in SKILL.md. The declared (secret-free)
	// @add recipe has to travel with the skill or they cannot reconstruct setup.
	return `# Project MCP servers

Read this when a listed server is missing from \`mcpx\`, an unknown-server
error appears, or a call returns \`reauth-required\` /
\`Credentials for <server> must be refreshed\`.

Project-approved servers live in the user's global mcpx registry, not in this
repository. Reconstruct a missing server with \`mcpx @add\` using the recipe
below.

## Diagnose

\`\`\`bash
mcpx
\`\`\`

If that command is missing, read [install.md](install.md) first. Then compare
the listing to the project-approved servers named in \`SKILL.md\`.

## Register missing servers

Run only the \`@add\` command for a server that is absent.

${sections.join('\n')}
## Authenticate

An ordinary \`mcpx <server>.<tool>\` call never starts login. If credentials
are missing or expired:

\`\`\`bash
mcpx @refresh
\`\`\`

\`@refresh\` may open a browser or prompt for an OAuth client. If the current
session is not a TTY, ask the user to run it in their terminal.

Once \`mcpx\` lists the server and a focused \`@schema\` call succeeds, return
to the skill.
`
}

export async function writeMcpxSkill(
	input: SkillTemplateInput,
): Promise<string> {
	const skillDir = mcpxSkillDir(input.cwd)
	const referencesDir = path.join(skillDir, 'references')
	await fs.mkdir(referencesDir, { recursive: true })
	await Promise.all([
		fs.writeFile(
			path.join(skillDir, 'SKILL.md'),
			buildMcpxSkillMarkdown(input.servers),
			'utf8',
		),
		fs.writeFile(
			path.join(referencesDir, 'install.md'),
			buildInstallReferenceMarkdown(),
			'utf8',
		),
		fs.writeFile(
			path.join(referencesDir, 'servers.md'),
			buildServersReferenceMarkdown(input.servers, input.declarations ?? {}),
			'utf8',
		),
	])
	return skillDir
}

export async function readMcpxSkillServers(cwd: string): Promise<string[]> {
	try {
		return parseMcpxSkillServers(await fs.readFile(mcpxSkillPath(cwd), 'utf8'))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw error
	}
}

export function parseMcpxSkillServers(content: string): string[] {
	const frontmatter = extractFrontmatter(content)
	if (!frontmatter) return []

	try {
		const parsed = YAML.parse(frontmatter) as unknown
		if (!isRecord(parsed) || !Array.isArray(parsed.servers)) return []

		return parsed.servers.filter(
			(server): server is string =>
				typeof server === 'string' && server.length > 0,
		)
	} catch {
		return []
	}
}

function projectTroubleshootingSection(): string {
	return `
## Troubleshooting

Stay on Discover/Call unless one of these symptoms appears:

- \`mcpx\` is missing (\`command not found\`, not on \`PATH\`, or \`mcpx --version\` fails) → [references/install.md](references/install.md)
- A listed server is missing from \`mcpx\`, or a call returns \`reauth-required\` / \`Credentials for … must be refreshed\` → [references/servers.md](references/servers.md)
`
}

function renderServerSection(
	name: string,
	declaration: SkillServerDeclaration | undefined,
): string {
	const command = declaration ? buildAddCommand(name, declaration) : undefined
	const notes = declaration ? serverNotes(declaration) : []
	const body = command
		? ['```bash', command, '```', ...notes.map((note) => `\n${note}`)].join(
				'\n',
			)
		: 'No stored `@add` recipe. Ask the user for the MCP URL or stdio command, then register it with `mcpx @add`.'

	return `### ${name}

${body}
`
}

function serverNotes(declaration: SkillServerDeclaration): string[] {
	if (declaration.transport === 'stdio') {
		if (!hasLocalPath(declaration)) return []
		return [
			'Stdio `command`/`args` may contain machine-local paths. If a path does not exist here, ask the user for the equivalent path on this machine.',
		]
	}

	const notes: string[] = []
	const envNames = bearerEnvNames(declaration)
	if (envNames.length > 0) {
		const listed = envNames.map((name) => `\`${name}\``).join(', ')
		notes.push(
			`This server reads ${listed} from the environment. If unset, ask the user to export ${envNames.length === 1 ? 'it' : 'them'} before retrying. Do not invent credentials.`,
		)
	}
	if (hasSecretBearer(declaration)) {
		notes.push(
			"This server requires a bearer token that was not stored as an environment reference. Ask the user for the token and set `bearer: 'env:NAME'` or a literal bearer value in the `@add` input.",
		)
	}
	return notes
}

function bearerEnvNames(declaration: SkillServerDeclaration): string[] {
	const names: string[] = []
	for (const credential of declaration.auth?.credentials ?? []) {
		if (credential.kind === 'env' && credential.name) {
			names.push(credential.name)
		}
	}
	return names
}

function hasSecretBearer(declaration: SkillServerDeclaration): boolean {
	return (declaration.auth?.credentials ?? []).some(
		(credential) =>
			credential.kind === 'literal' || credential.kind === 'stored',
	)
}

function hasLocalPath(declaration: SkillServerDeclaration): boolean {
	const values = [declaration.command, ...(declaration.args ?? [])].filter(
		(value): value is string => typeof value === 'string',
	)
	return values.some(
		(value) =>
			value.startsWith('/') ||
			value.startsWith('~/') ||
			value === '~' ||
			/^[A-Za-z]:[\\/]/.test(value),
	)
}

function shellQuote(value: string): string {
	if (value.length > 0 && /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
	return `'${value.replaceAll("'", "'\\''")}'`
}

function extractFrontmatter(content: string): string | undefined {
	const lines = content
		.replaceAll('\r\n', '\n')
		.replaceAll('\r', '\n')
		.split('\n')
	if (lines[0] !== '---') return undefined

	const closingIndex = lines.findIndex(
		(line, index) => index > 0 && line === '---',
	)
	if (closingIndex === -1) return undefined

	return lines.slice(1, closingIndex).join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
