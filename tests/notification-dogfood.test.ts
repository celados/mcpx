import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const mainPath = path.join(import.meta.dir, "..", "src", "main.ts");
const fixturePath = path.join(import.meta.dir, "fixtures", "notification-mcp-server.mjs");

let home: string;

describe("notification fixture dogfood", () => {
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(tmpdir(), "mcpx-notification-dogfood-"));
  });

  afterEach(async () => {
    await runMcpx(["@daemon", "stop"]).catch(() => {});
    await fs.rm(home, { recursive: true, force: true });
  });

  it("covers notification rendering, schema write-back, and daemon status through the CLI", async () => {
    const added = await runMcpx([
      "@add",
      "--name",
      "notification-fixture",
      "--transport",
      "stdio",
      "--command",
      process.execPath,
      "--arg",
      fixturePath,
      "--raw",
    ]);
    expect(JSON.parse(added.stdout)).toMatchObject({
      name: "notification-fixture",
      transport: "stdio",
      status: "ready",
      tools: 5,
    });

    const progress = decode(
      (await runMcpx(["notification-fixture", "progress-stream", "--count", "4"])).stdout,
    ) as Record<string, unknown>;
    expect(progress).toMatchObject({
      tool: "progress-stream",
      count: 4,
      "@notifications": [
        {
          method: "notifications/progress",
          params: expect.objectContaining({ progress: 1, total: 4, message: "step 1" }),
        },
        {
          method: "notifications/progress",
          params: expect.objectContaining({ progress: 4, total: 4, message: "step 4" }),
          aggregatedCount: 2,
        },
      ],
    });

    const progressRaw = JSON.parse(
      (await runMcpx(["notification-fixture", "progress-stream", "--count", "4", "--raw"])).stdout,
    );
    expect(progressRaw.result.structuredContent).toEqual({
      tool: "progress-stream",
      count: 4,
    });
    expect(progressRaw.notifications).toEqual([
      {
        method: "notifications/progress",
        params: expect.objectContaining({ progress: 1, total: 4, message: "step 1" }),
      },
      {
        method: "notifications/progress",
        params: expect.objectContaining({ progress: 4, total: 4, message: "step 4" }),
        aggregatedCount: 2,
      },
    ]);

    const toolsChanged = JSON.parse(
      (await runMcpx(["notification-fixture", "notify-tools-changed", "--raw"])).stdout,
    );
    expect(toolsChanged.notifications).toContainEqual({
      method: "notifications/tools/list_changed",
    });

    const verbatim = JSON.parse(
      (await runMcpx(["notification-fixture", "verbatim-notify", "--raw"])).stdout,
    );
    expect(verbatim.notifications).toEqual([
      {
        method: "notifications/custom/event",
        params: { source: "notification-fixture", ok: true },
      },
    ]);

    const flood = decode(
      (await runMcpx(["notification-fixture", "flood-notify"])).stdout,
    ) as Record<string, unknown>;
    const oversizeMessage = String(flood["@notifications"]);
    expect(oversizeMessage).toMatch(
      /^notifications oversize, saved to .+mcpx-notifications-.+\.json$/,
    );
    const savedTo = oversizeMessage.replace("notifications oversize, saved to ", "");
    const savedNotifications = JSON.parse(await fs.readFile(savedTo, "utf8"));
    expect(savedNotifications).toHaveLength(120);
    expect(savedNotifications[0]).toMatchObject({
      method: "notifications/custom/flood",
      params: { index: 0 },
    });

    const beforeIdle = await readRegisteredServerDiscoveredAt();
    await runMcpx(["notification-fixture", "idle-tools-changed", "--raw"]);
    await sleep(75);
    await runMcpx(["notification-fixture", "progress-stream", "--count", "0", "--raw"]);
    const afterIdle = await readRegisteredServerDiscoveredAt();
    expect(afterIdle).not.toBe(beforeIdle);

    const status = JSON.parse((await runMcpx(["@daemon", "status", "--raw"])).stdout);
    expect(status.servers).toContainEqual(
      expect.objectContaining({
        transport: "stdio",
        labels: ["notification-fixture"],
        activeCalls: 0,
        queuedCalls: 0,
        evictCount: 0,
        hasRetainedSessionId: false,
      }),
    );
  });
});

async function runMcpx(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, mainPath, ...args], {
    env: {
      ...process.env,
      HOME: home,
      MCPX_HOME: home,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`mcpx ${args.join(" ")} failed with ${exitCode}\n${stderr}\n${stdout}`);
  }
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function readRegisteredServerDiscoveredAt(): Promise<string | undefined> {
  const raw = await fs.readFile(path.join(home, ".agents", "mcpx", "servers.json"), "utf8");
  return JSON.parse(raw).servers["notification-fixture"].discoveredAt;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
