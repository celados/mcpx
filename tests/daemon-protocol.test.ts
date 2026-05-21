import { describe, expect, it } from "bun:test";

import { buildServerKey } from "../src/daemon-protocol";
import type { HttpServerConfig } from "../src/types";

describe("daemon protocol", () => {
  it("keeps HTTP server keys stable across resolved token values", () => {
    const server: HttpServerConfig = {
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer old" },
      auth: { kind: "bearer", source: "env", env: "MCP_TOKEN", confidence: "configured" },
    };
    const rotated: HttpServerConfig = {
      ...server,
      headers: { Authorization: "Bearer new" },
    };

    expect(buildServerKey(rotated)).toBe(buildServerKey(server));
  });

  it("isolates HTTP server keys by auth reference", () => {
    const first: HttpServerConfig = {
      url: "https://mcp.example.com/mcp",
      auth: { kind: "bearer", source: "env", env: "FIRST_TOKEN", confidence: "configured" },
    };
    const second: HttpServerConfig = {
      ...first,
      auth: { kind: "bearer", source: "env", env: "SECOND_TOKEN", confidence: "configured" },
    };

    expect(buildServerKey(second)).not.toBe(buildServerKey(first));
  });
});
