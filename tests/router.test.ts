import { describe, expect, it } from "bun:test";

import { __test } from "../src/router";

describe("router", () => {
  it("keeps mcpx control commands under the @ namespace", () => {
    const router = __test.buildRouter({
      config: { version: 1, servers: {} },
      ensureServerReady: async () => {
        throw new Error("not used");
      },
      reauthenticateServer: async () => {
        throw new Error("not used");
      },
      save: async () => {},
    });

    expect(Object.keys(router).sort()).toEqual(["@add", "@refresh", "@remove", "@skill"]);
  });

  it("describes server groups by tool count", () => {
    expect(__test.describeServerTools(0)).toBe("(0 tools)");
    expect(__test.describeServerTools(1)).toBe("(1 tool)");
    expect(__test.describeServerTools(123)).toBe("(123 tools)");
  });

  it("includes title and safety annotations in tool descriptions", () => {
    expect(
      __test.describeTool(
        {
          name: "close_page",
          title: "Close Page",
          description: "Close a browser page",
          annotations: { destructiveHint: true, idempotentHint: true },
        },
        "browser",
      ),
    ).toBe("Close Page — Close a browser page — [destructive, idempotent]");
  });
});
