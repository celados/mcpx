import { pickFiles } from 'argc/skill'

// Build-time picker: which src/ files are agent-facing is an editorial
// decision per project — keep the list explicit, not a framework convention.
export function embedSkill(): Record<string, string> {
	return pickFiles(import.meta.dir, ['SKILL.md', 'references/**/*.md'])
}
