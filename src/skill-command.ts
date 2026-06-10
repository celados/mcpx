import { cancel, isCancel, multiselect } from "@clack/prompts";

import { buildMcpxSkillMarkdown, readMcpxSkillServers, writeMcpxSkill } from "./skill-template";
import type { ProjectService } from "./project-service";

export type SkillCommandInput = {
  servers?: string;
  show?: string;
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

  if (input.show !== undefined) {
    if (input.servers !== undefined) {
      throw new Error("--show cannot be combined with --servers.");
    }
    const server = normalizeShownServer(input.show, availableServers);
    process.stdout.write(buildMcpxSkillMarkdown([server], { projectLocal: false }));
    return;
  }

  const selectedServers =
    input.servers === undefined
      ? await promptForServers(availableServers, await readMcpxSkillServers(cwd))
      : normalizeSelectedServers(input.servers, availableServers);

  const filePath = await writeMcpxSkill({ cwd, servers: selectedServers });
  console.log(`Wrote ${filePath}`);
}

async function promptForServers(
  availableServers: string[],
  selectedServers: string[],
): Promise<string[]> {
  const available = new Set(availableServers);
  const initialValues = selectedServers.filter((server) => available.has(server));
  const result = await multiselect({
    message: "Select MCP servers for this project",
    options: availableServers.map((server) => ({ value: server, label: server })),
    initialValues,
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

function normalizeShownServer(value: string, availableServers: string[]): string {
  const server = value.trim();
  if (server.length === 0 || server.includes(",")) {
    throw new Error("Select exactly one MCP server for --show.");
  }

  const available = new Set(availableServers);
  if (!available.has(server)) {
    throw new Error(`Unknown MCP server: ${server}`);
  }
  return server;
}
