import { domainError, isAgentCapture } from '@celados/argc'
import { cancel, isCancel, multiselect } from '@clack/prompts'

import type { RegistryConfig } from './types'

import {
	buildMcpxSkillMarkdown,
	readMcpxSkillServers,
	writeMcpxSkill,
} from './skill-template'

export type SkillCommandInput = {
	servers?: string
	show?: string
}

export type RegistryView = Pick<RegistryConfig, 'servers'>

export async function runSkillCommand(
	registry: RegistryView,
	cwd: string,
	input: SkillCommandInput,
	captured: () => boolean = isAgentCapture,
): Promise<string> {
	const availableServers = Object.keys(registry.servers).sort()
	if (availableServers.length === 0) {
		throw new Error(
			`No MCP servers are registered. Run mcpx @add "{ name: '<name>', url: '<url>' }" first.`,
		)
	}

	if (input.show !== undefined) {
		if (input.servers !== undefined) {
			throw new Error('--show cannot be combined with --servers.')
		}
		const server = normalizeShownServer(input.show, availableServers)
		// A guide like @skill: argc guards its own guides, this one is ours.
		if (captured()) throw showCaptured(server)
		return buildMcpxSkillMarkdown([server], { projectLocal: false })
	}

	const selectedServers =
		input.servers === undefined
			? await promptForServers(
					availableServers,
					await readMcpxSkillServers(cwd),
				)
			: normalizeSelectedServers(input.servers, availableServers)

	const skillDir = await writeMcpxSkill({
		cwd,
		servers: selectedServers,
		declarations: registry.servers,
	})
	return `Wrote ${skillDir}\n`
}

async function promptForServers(
	availableServers: string[],
	selectedServers: string[],
): Promise<string[]> {
	const available = new Set(availableServers)
	const initialValues = selectedServers.filter((server) =>
		available.has(server),
	)
	const result = await multiselect({
		message: 'Select MCP servers for this project',
		options: availableServers.map((server) => ({
			value: server,
			label: server,
		})),
		initialValues,
		required: true,
	})

	if (isCancel(result)) {
		cancel('No mcpx skill generated.')
		process.exit(1)
	}

	return result
}

function normalizeSelectedServers(
	value: string,
	availableServers: string[],
): string[] {
	const selected = value
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)

	if (selected.length === 0) {
		throw new Error('Select at least one MCP server.')
	}

	const available = new Set(availableServers)
	const unknown = selected.filter((server) => !available.has(server))
	if (unknown.length > 0) {
		throw new Error(`Unknown MCP server(s): ${unknown.join(', ')}`)
	}

	return [...new Set(selected)].sort()
}

function normalizeShownServer(
	value: string,
	availableServers: string[],
): string {
	const server = value.trim()
	if (server.length === 0 || server.includes(',')) {
		throw new Error('Select exactly one MCP server for --show.')
	}

	const available = new Set(availableServers)
	if (!available.has(server)) {
		throw new Error(`Unknown MCP server: ${server}`)
	}
	return server
}

// Same refusal argc gives @skill/@schema (spec 7.12): an agent piping the guide
// into head/grep would act on a fragment.
function showCaptured(server: string): Error {
	const line = `mcpx @skill-install "{ show: '${server}' }"`
	return domainError(
		'OUTPUT_CAPTURED',
		`mcpx @skill-install --show is meant to be read whole, and stdout is a pipe or $(…): head/tail/grep/sed/rg would hand you a fragment that reads like the whole. Nothing ran.`,
		{
			$hint: [
				'run it alone — the shell tool shows all of it:',
				`  ${line}`,
				'or keep it whole in a file, then read the whole file:',
				`  ${line} > "\${TMPDIR:-/tmp}/mcpx-skill-${server}.out"`,
			].join('\n'),
		},
	)
}
