import { cancel, isCancel, multiselect } from "@clack/prompts";

import { writeMcpxSkill } from "./skill-template";
import type { ProjectService } from "./project-service";

export type SkillCommandInput = {
  servers?: string;
};

export async function runSkillCommand(
  service: ProjectService,
  cwd: string,
  input: SkillCommandInput,
): Promise<void> {
  const availableServers = Object.keys(service.config.servers).sort();
  if (availableServers.length === 0) {
    throw new Error(
      'No MCP servers are registered. Run "mcpx @add --name <name> --url <url>" first.',
    );
  }

  const selectedServers =
    input.servers === undefined
      ? await promptForServers(availableServers)
      : normalizeSelectedServers(input.servers, availableServers);

  const filePath = await writeMcpxSkill({ cwd, servers: selectedServers });
  console.log(`Wrote ${filePath}`);
}

async function promptForServers(availableServers: string[]): Promise<string[]> {
  const result = await multiselect({
    message: "Select MCP servers for this project",
    options: availableServers.map((server) => ({ value: server, label: server })),
    required: true,
  });

  if (isCancel(result)) {
    cancel("No mcpx skill generated.");
    process.exit(1);
  }

  return result;
}

function normalizeSelectedServers(value: string, availableServers: string[]): string[] {
  const selected = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (selected.length === 0) {
    throw new Error("Select at least one MCP server.");
  }

  const available = new Set(availableServers);
  const unknown = selected.filter((server) => !available.has(server));
  if (unknown.length > 0) {
    throw new Error(`Unknown MCP server(s): ${unknown.join(", ")}`);
  }

  return [...new Set(selected)].sort();
}
