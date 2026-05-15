import { describe, expect, it } from "bun:test";

import { buildRefreshSummary, hasStaleSchemas, isSchemaRefreshStale } from "../src/schema-refresh";

describe("schema refresh", () => {
  const now = new Date("2026-05-15T00:00:00.000Z");

  it("marks cached schemas stale after one day", () => {
    expect(
      isSchemaRefreshStale(
        {
          url: "https://mcp.example.com/mcp",
          auth: { kind: "none" },
          discoveredAt: "2026-05-13T23:59:59.000Z",
          tools: [{ name: "search", commandName: "search" }],
        },
        now,
      ),
    ).toBe(true);
  });

  it("does not refresh missing schemas through the background stale path", () => {
    expect(
      isSchemaRefreshStale(
        {
          url: "https://mcp.example.com/mcp",
          auth: { kind: "none" },
        },
        now,
      ),
    ).toBe(false);
  });

  it("detects a registry with at least one stale server", () => {
    expect(
      hasStaleSchemas(
        {
          version: 1,
          servers: {
            fresh: {
              url: "https://fresh.example.com/mcp",
              auth: { kind: "none" },
              discoveredAt: "2026-05-14T12:00:00.000Z",
              tools: [{ name: "search", commandName: "search" }],
            },
            stale: {
              url: "https://stale.example.com/mcp",
              auth: { kind: "none" },
              discoveredAt: "2026-05-13T00:00:00.000Z",
              tools: [{ name: "search", commandName: "search" }],
            },
          },
        },
        now,
      ),
    ).toBe(true);
  });

  it("summarizes refresh status as server name lists", () => {
    expect(
      buildRefreshSummary([
        {
          server: "changed",
          status: "schema-refreshed",
          toolsBefore: 1,
          toolsAfter: 2,
          schemaChanged: true,
        },
        {
          server: "same",
          status: "schema-refreshed",
          toolsBefore: 2,
          toolsAfter: 2,
          schemaChanged: false,
        },
        {
          server: "token",
          status: "auth-refreshed",
          toolsBefore: 3,
          toolsAfter: 3,
          schemaChanged: false,
        },
        {
          server: "reauth",
          status: "reauthenticated",
          toolsBefore: 3,
          toolsAfter: 4,
          schemaChanged: true,
        },
        {
          server: "expired",
          status: "reauth-required",
          toolsBefore: 4,
        },
        {
          server: "down",
          status: "unreachable",
          toolsBefore: 5,
        },
      ]),
    ).toMatchObject({
      refreshed: ["changed", "reauth"],
      unchanged: ["same", "token"],
      authRefreshed: ["token"],
      reauthenticated: ["reauth"],
      reauthRequired: ["expired"],
      unreachable: ["down"],
    });
  });
});
