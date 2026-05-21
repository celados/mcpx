import fs from "node:fs/promises";
import path from "node:path";

import { YAML } from "bun";

export type SkillTemplateInput = {
  cwd: string;
  servers: string[];
};

export function mcpxSkillPath(cwd: string): string {
  return path.join(cwd, ".agents", "skills", "mcpx", "SKILL.md");
}

export function buildSchemaSelector(servers: string[]): string {
  if (servers.length === 0) {
    throw new Error("Select at least one MCP server.");
  }
  if (servers.length === 1) {
    return `.${servers[0]}`;
  }
  return `.{${servers.join(",")}}`;
}

export function buildMcpxSkillMarkdown(servers: string[]): string {
  const selector = buildSchemaSelector(servers);
  const serverList = servers.map((server) => `- ${server}`).join("\n");
  const description = `Use project-approved MCP tools through mcpx. Trigger when the user asks to inspect or operate services backed by these MCP servers: ${servers.join(", ")}.`;

  return `---
name: ${JSON.stringify("mcpx")}
servers: [${servers.map((server) => JSON.stringify(server)).join(", ")}]
description: ${JSON.stringify(description)}
---

# MCPX

Use this skill when the task needs one of these MCP servers:

${serverList}

## Discover

Inspect the available tool surface before calling tools:

\`\`\`bash
mcpx --schema="${selector}"
\`\`\`

Use schema selectors to narrow large MCP surfaces before choosing a tool:

- \`.server\` shows one server, for example \`mcpx --schema=.posthog\`
- \`.server.tool\` shows one tool, for example \`mcpx --schema=.posthog.projects-get\`
- \`.{a,b}\` selects multiple keys at the current level
- \`.server.{tool-a,tool-b,tool-c}\` shows a short list of candidate tools

Normal workflow: inspect the project-approved servers first, identify likely
tool names from the outline, then run a narrower selector such as
\`mcpx --schema=.posthog.{projects-get,alerts-list,alert-create}\` before
calling a tool.

## Call

Call MCP tools through root server commands and pass tool input only through \`--input\`.
\`--input\` accepts inline JSON/JSON5, \`@file\`, and \`@-\` stdin values through argc.

\`\`\`bash
mcpx <server> <tool> --input '{ }'
\`\`\`

For larger payloads, prefer file or heredoc input:

\`\`\`bash
mcpx <server> <tool> --input @payload.json

mcpx <server> <tool> --input @- <<'JSON'
{
  "example": true
}
JSON
\`\`\`

## Notifications

Most tool calls emit no notifications and this section never applies. When an
MCP server pushes events during a call (progress, schema changes, custom
events), mcpx merges them into default structured output under \`@notifications\`:

\`\`\`
count: 1
@notifications[1]{method,params}:
  notifications/progress,{progressToken:"...",progress:3,total:4,message:"step 3"}
\`\`\`

For non-JSON text, binary, or mixed content, mcpx falls back to a trailing
sentinel line:

\`\`\`
<tool result lines>
@notification: [{"method":"notifications/progress","params":{...}}]
\`\`\`

Each entry has \`method\` plus method-specific \`params\`. Special cases:

- \`notifications/progress\` may carry \`aggregatedCount\` on the last entry per progress token, meaning intermediate progress was collapsed (first and last preserved verbatim).
- \`notifications/tools/list_changed\` is handled by mcpx automatically; no agent action required.
- \`$oversize\` appears in raw mode when the buffer cap was reached; default output renders it as \`notifications oversize, saved to <path>\`.

In \`--raw\` mode with a structured result and non-empty notifications, the
sentinel line is replaced by a JSON envelope:

\`\`\`json
{ "result": <tool-result>, "notifications": [ ... ] }
\`\`\`

Ignore notifications unless the task specifically depends on progress or
server events. Parse only when \`@notifications\`, the sentinel line, or the raw
envelope is present.

Do not hand-edit MCP configuration in this project. Servers are registered in the user's global mcpx registry.
`;
}

export async function writeMcpxSkill(input: SkillTemplateInput): Promise<string> {
  const filePath = mcpxSkillPath(input.cwd);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buildMcpxSkillMarkdown(input.servers), "utf8");
  return filePath;
}

export async function readMcpxSkillServers(cwd: string): Promise<string[]> {
  try {
    return parseMcpxSkillServers(await fs.readFile(mcpxSkillPath(cwd), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function parseMcpxSkillServers(content: string): string[] {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return [];

  try {
    const parsed = YAML.parse(frontmatter) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.servers)) return [];

    return parsed.servers.filter(
      (server): server is string => typeof server === "string" && server.length > 0,
    );
  } catch {
    return [];
  }
}

function extractFrontmatter(content: string): string | undefined {
  const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines[0] !== "---") return undefined;

  const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closingIndex === -1) return undefined;

  return lines.slice(1, closingIndex).join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
