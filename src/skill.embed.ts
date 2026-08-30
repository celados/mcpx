import { pickFiles } from '@celados/argc/skill'

// Build-time picker: which src/ files are agent-facing is an editorial
// decision per project — keep the list explicit, not a framework convention.
export function embedSkill(): Record<string, string> {
	const { 'index.md': body, ...references } = pickFiles(import.meta.dir, [
		'index.md',
		'references/**/*.md',
	])
	if (body === undefined)
		throw new Error('Embedded skill body is missing index.md')
	return { 'SKILL.md': body, ...references }
}
