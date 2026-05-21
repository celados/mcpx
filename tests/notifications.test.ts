import { describe, expect, it } from "bun:test";

import { createNotificationBuffer } from "../src/notifications";

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
});
