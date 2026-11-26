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

const MCPX_SERVERS_SKILL_NAME = 'mcpx-servers'

function mcpxSkillDir(cwd: string): string {
	return path.join(cwd, '.agents', 'skills', MCPX_SERVERS_SKILL_NAME)
}

function mcpxSkillPath(cwd: string): string {
	return path.join(mcpxSkillDir(cwd), 'SKILL.md')
}

export function buildSchemaSelector(servers: string[]): string {
	if (servers.length === 0) {
		throw new Error('Select at least one MCP server.')
	}
	// Naming a group shows one folded line; `.*` lists its tools.
	if (servers.length === 1) return `${servers[0]!}.*`
	return `{${servers.join(',')}}.*`
}

export function buildMcpxSkillMarkdown(
	servers: string[],
	options: SkillMarkdownOptions = {},
): string {
	const projectLocal = options.projectLocal ?? true
	const selector = buildSchemaSelector(servers)
	const first = servers[0]!
	const serverList = servers.map((server) => `- ${server}`).join('\n')
	const description = projectLocal
		? `Use this project's approved MCP servers through mcpx: ${servers.join(', ')}. Trigger when inspecting or operating services backed by these servers.`
		: `Use configured MCP servers through mcpx: ${servers.join(', ')}. Trigger when inspecting or operating services backed by these servers.`
	const scope = projectLocal ? 'project-approved' : 'configured'
	const troubleshooting = projectLocal ? projectTroubleshootingSection() : ''

	return `---
name: ${MCPX_SERVERS_SKILL_NAME}
servers: [${servers.map((server) => JSON.stringify(server)).join(', ')}]
description: ${JSON.stringify(description)}
---

# MCPX Servers

Use this skill when the task needs one of these ${scope} MCP servers:

${serverList}

## Discover

Inspect the ${scope} tool surface before calling tools:

\`\`\`bash
mcpx @schema '${selector}'
\`\`\`

A selector is the call path itself; quote any with \`*\` or \`{\`:

- \`'${first}.*'\` lists one server's tools with their signatures
- \`${first}.<tool>\` shows one tool
- \`'${first}.{tool-a,tool-b}'\` shows a shortlist
- \`'${first}.*keyword*'\` matches tool names by glob

Don't know the tool name? Search by intent:
\`mcpx @search <keywords> --in ${first}\`.

Follow the schema's \`status:\` line: if it says fully shown, call the tool
directly; otherwise run the \`next:\` it gives or a narrower selector.

## Call

\`\`\`bash
mcpx <server>.<tool> '<object>'
\`\`\`

- Omit the input object when the tool takes no arguments (defaults to \`{}\`).
- For multi-line or large payloads, pass the whole object as YAML via quoted heredoc (\`|\` block scalars) or \`@file\`:

\`\`\`bash
mcpx <server>.<tool> - <<'EOF'
example: true
text: |
  multi-line text
EOF

mcpx <server>.<tool> @payload.yaml
\`\`\`

- Field values are always literal (no per-field \`-\` or \`@path\`). Quote YAML scalars that would retype (\`'1.10'\`, \`'012'\`, \`'true'\`).
- Default output is agent-optimized YAML (media saved as \`file saved <path>\`). Pass \`--context "{ output: 'raw' }"\` only when exact server output matters.
- Tool results may include \`$notifications\` or a trailing \`$notification:\` line. Ignore them unless the task depends on progress or server events; see \`mcpx @skill references/notifications.md\`.

Do not hand-edit MCP configuration in this project. Servers live in the user's global mcpx registry; for registry management (\`@add\`, \`@remove\`, \`@login\`) or \`mcpxd\` troubleshooting, run \`mcpx @skill\`.
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
mcpx @schema
\`\`\`

If that command is missing, read [install.md](install.md) first. Otherwise
compare the \`## <server>.*\` groups against the project-approved servers in
\`SKILL.md\` (or probe one directly with \`mcpx @schema <server>\`).

## Register missing servers

Run only the \`@add\` command for a server that is absent.

${sections.join('\n')}
## Authenticate

An ordinary \`mcpx <server>.<tool>\` call refreshes expired OAuth tokens itself.
When browser authorization is needed — including the first call to a protected
tool on a server that lists its tools anonymously — the call prints the authorization URL to
stderr and waits up to 5 minutes; share that URL with the user and let the call
finish. If a call still returns \`reauth-required\` (for example, a provider
that needs a manual OAuth client and no terminal is available), or the user
wants a different account, run:

\`\`\`bash
mcpx @login "{ name: '<server>' }"
\`\`\`

If the current session is not a TTY, ask the user to run it in their terminal.

Once \`mcpx @schema <server>\` succeeds for each needed server, return to the
skill.
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
