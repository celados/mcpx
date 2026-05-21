import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "mcpx-notification-fixture", version: "1.0.0" });

server.registerTool(
  "progress-stream",
  {
    title: "Progress Stream",
    description: "Emit a configurable number of progress notifications",
    inputSchema: {
      count: z.number().int().min(0).max(20).default(4),
    },
  },
  async (args, extra) => {
    for (let index = 1; index <= args.count; index += 1) {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: extra.requestId,
          progress: index,
          total: args.count,
          message: `step ${index}`,
        },
      });
    }
    await sleep(10);
    return result("progress-stream", { count: args.count });
  },
);

server.registerTool(
  "notify-tools-changed",
  {
    title: "Notify Tools Changed",
    description: "Emit notifications/tools/list_changed during the call",
    inputSchema: {},
  },
  async (_args, extra) => {
    await extra.sendNotification({ method: "notifications/tools/list_changed" });
    return result("notify-tools-changed");
  },
);

server.registerTool(
  "verbatim-notify",
  {
    title: "Verbatim Notify",
    description: "Emit an unknown notification method for passthrough checks",
    inputSchema: {},
  },
  async (_args, extra) => {
    await extra.sendNotification({
      method: "notifications/custom/event",
      params: { source: "notification-fixture", ok: true },
    });
    return result("verbatim-notify");
  },
);

server.registerTool(
  "flood-notify",
  {
    title: "Flood Notify",
    description: "Emit enough notifications to trigger daemon truncation",
    inputSchema: {},
  },
  async (_args, extra) => {
    const payload = "x".repeat(1_024);
    for (let index = 0; index < 120; index += 1) {
      await extra.sendNotification({
        method: "notifications/custom/flood",
        params: { index, payload },
      });
    }
    return result("flood-notify");
  },
);

server.registerTool(
  "idle-tools-changed",
  {
    title: "Idle Tools Changed",
    description: "Emit tools/list_changed after the current call has completed",
    inputSchema: {},
  },
  async () => {
    setTimeout(() => {
      void server.server.sendToolListChanged();
    }, 25).unref();
    return result("idle-tools-changed");
  },
);

function result(tool, extra = {}) {
  return {
    content: [{ type: "text", text: `${tool}-ok` }],
    structuredContent: { tool, ...extra },
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

await server.connect(new StdioServerTransport());
