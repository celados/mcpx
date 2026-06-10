import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { runSkillCommand } from "../src/skill-command";
import type { ProjectService } from "../src/project-service";

function fixtureService(): ProjectService {
  return {
    config: {
      version: 1,
      servers: {
        slack: {
          transport: "stdio",
          command: "slack-mcp",
          tools: [],
        },
      },
    },
    ensureServerReady: async () => {
      throw new Error("not used");
    },
    reauthenticateServer: async () => {
      throw new Error("not used");
    },
    save: async () => {},
  };
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  try {
    await run();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe("mcpx skill command", () => {
  it("prints a temporary server skill without writing project files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mcpx-skill-show-"));
    const output = await captureStdout(async () => {
      await runSkillCommand(fixtureService(), cwd, { show: "slack" });
    });

    expect(output).toContain('servers: ["slack"]');
    expect(output).toContain("configured MCP servers");
    expect(output).toContain('mcpx --schema=".slack"');
    await expect(
      readFile(join(cwd, ".agents", "skills", "mcpx", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("rejects mixing temporary show and project skill generation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mcpx-skill-show-"));

    await expect(
      runSkillCommand(fixtureService(), cwd, { servers: "slack", show: "slack" }),
    ).rejects.toThrow("--show cannot be combined with --servers.");
  });
});
