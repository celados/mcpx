import { describe, expect, it } from "bun:test";

import { daemonOutputEnvelope } from "../src/daemon-result";
import { createNotificationBuffer } from "../src/notifications";
import { printOutput } from "../src/output";

describe("notification buffer", () => {
  it("aggregates intermediate progress notifications by token", () => {
    const buffer = createNotificationBuffer();

    for (const progress of [1, 2, 3, 4]) {
      buffer.add({
        method: "notifications/progress",
        params: { progressToken: "call", progress },
      });
    }

    expect(buffer.flush()).toEqual([
      { method: "notifications/progress", params: { progressToken: "call", progress: 1 } },
      {
        method: "notifications/progress",
        params: { progressToken: "call", progress: 4 },
        aggregatedCount: 2,
      },
    ]);
  });

  it("passes unknown notifications through verbatim", () => {
    const buffer = createNotificationBuffer();
    buffer.add({ method: "notifications/message", params: { level: "info" } });

    expect(buffer.flush()).toEqual([
      { method: "notifications/message", params: { level: "info" } },
    ]);
  });

  it("marks tools/list_changed for CLI write-back", () => {
    const buffer = createNotificationBuffer();
    buffer.add({ method: "notifications/tools/list_changed" });

    expect(buffer.toolsChanged()).toBe(true);
  });

  it("does not expose JSON-RPC transport fields in rendered notifications", async () => {
    const log = captureConsoleLog();
    try {
      await printOutput(
        daemonOutputEnvelope({
          result: { content: [{ type: "text", text: "ok" }] },
          notifications: [
            {
              method: "notifications/custom/event",
              params: { ok: true },
              jsonrpc: "2.0",
            } as never,
          ],
        }),
        { output: "toon" },
      );

      expect(log.calls.map((call) => call[0])).toEqual([
        "ok",
        '@notification: [{"method":"notifications/custom/event","params":{"ok":true}}]',
      ]);
    } finally {
      log.restore();
    }
  });
});

function captureConsoleLog(): { calls: unknown[][]; restore: () => void } {
  const original = console.log;
  const calls: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    restore: () => {
      console.log = original;
    },
  };
}
