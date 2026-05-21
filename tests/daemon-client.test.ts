import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { daemonStatus, stopDaemon } from "../src/daemon-client";
import { daemonSocketPath } from "../src/daemon-paths";
import { writeJsonLine } from "../src/daemon-io";
import { callMcpTool, listMcpTools } from "../src/mcp-client";
import type { StdioServerConfig } from "../src/types";

const mainPath = path.join(import.meta.dir, "..", "src", "main.ts");

let previousHome: string | undefined;
let previousMcpxHome: string | undefined;
let previousDisableDaemon: string | undefined;
let previousArgvOne: string | undefined;
let home: string;
let daemon: ReturnType<typeof Bun.spawn> | undefined;
let fakeDaemon: net.Server | undefined;
let httpFixture: http.Server | undefined;

describe("mcpxd daemon client", () => {
  beforeEach(async () => {
    previousHome = process.env.HOME;
    previousMcpxHome = process.env.MCPX_HOME;
    previousDisableDaemon = process.env.MCPX_DISABLE_DAEMON;
    previousArgvOne = process.argv[1];
    home = await fs.mkdtemp(path.join(tmpdir(), "mcpxd-test-"));
    process.env.HOME = home;
    process.env.MCPX_HOME = home;
    delete process.env.MCPX_DISABLE_DAEMON;
  });

  afterEach(async () => {
    await stopDaemon(mainPath).catch(() => {});
    await stopFakeDaemon();
    await stopHttpFixture();
    daemon?.kill();
    daemon = undefined;
    await fs.rm(home, { recursive: true, force: true });
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousDisableDaemon === undefined) {
      delete process.env.MCPX_DISABLE_DAEMON;
    } else {
      process.env.MCPX_DISABLE_DAEMON = previousDisableDaemon;
    }
    if (previousMcpxHome === undefined) {
      delete process.env.MCPX_HOME;
    } else {
      process.env.MCPX_HOME = previousMcpxHome;
    }
    if (previousArgvOne === undefined) {
      process.argv.splice(1, 1);
    } else {
      process.argv[1] = previousArgvOne;
    }
  });

  it("starts mcpxd on demand for stdio calls", async () => {
    process.argv[1] = mainPath;
    const server = fixtureServer();

    expect((await listMcpTools(server, "fixture")).map((tool) => tool.name)).toContain("echo");
    expect((await daemonStatus(mainPath)).activeServers).toBe(1);
    expect((await fs.stat(daemonSocketPath())).mode & 0o777).toBe(0o600);
  });

  it("reuses a stdio server process across separate calls", async () => {
    await startDaemon();
    const server = fixtureServer();

    expect((await listMcpTools(server, "fixture")).map((tool) => tool.name)).toContain("pid");
    const firstPid = text(await callMcpTool(server, "pid", {}, "fixture"));
    expect(text(await callMcpTool(server, "increment", {}, "fixture"))).toBe("1");
    expect(text(await callMcpTool(server, "increment", {}, "fixture"))).toBe("2");
    const secondPid = text(await callMcpTool(server, "pid", {}, "fixture"));

    expect(secondPid).toBe(firstPid);
    expect((await daemonStatus(mainPath)).activeServers).toBe(1);
  });

  it("passes cwd to managed stdio processes", async () => {
    await startDaemon();
    const cwd = await fs.mkdtemp(path.join(home, "cwd-"));
    const server = fixtureServer({ cwd });

    expect(await fs.realpath(text(await callMcpTool(server, "cwd", {}, "fixture")))).toBe(
      await fs.realpath(cwd),
    );
  });

  it("routes HTTP servers through mcpxd and preserves session ids", async () => {
    await startDaemon();
    const fixture = await startHttpFixture();
    const server = {
      url: fixture.url,
      auth: { kind: "none" as const },
    };

    expect((await listMcpTools(server, "http-fixture")).map((tool) => tool.name)).toEqual(["echo"]);
    expect(text(await callMcpTool(server, "echo", {}, "http-fixture"))).toBe("http-ok");

    expect(fixture.sessions.slice(1).every((session) => session === "session-1")).toBe(true);
    expect((await daemonStatus(mainPath)).servers[0]).toMatchObject({
      transport: "http",
      url: expect.stringContaining("/mcp"),
    });
  });

  it("stops an incompatible daemon before starting a compatible one", async () => {
    await startFakeDaemon();
    process.argv[1] = mainPath;

    expect(text(await callMcpTool(fixtureServer(), "echo", {}, "fixture"))).toBe("ok");
    expect(fakeDaemon).toBeUndefined();
    expect((await daemonStatus(mainPath)).protocolVersion).toBe(2);
  });

  it("reports and stops the daemon", async () => {
    await startDaemon();
    const server = fixtureServer();

    await callMcpTool(server, "echo", {}, "fixture");
    expect((await daemonStatus(mainPath)).servers[0]?.labels).toEqual(["fixture"]);
    expect(await stopDaemon(mainPath)).toEqual({ stopping: true });
    await waitForStopped();
  });
});

async function startDaemon(): Promise<void> {
  daemon = Bun.spawn([process.execPath, mainPath, "@daemon", "server"], {
    env: {
      ...process.env,
      MCPX_DAEMON_SERVER: "1",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await daemonStatus(mainPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("daemon did not start");
}

function fixtureServer(overrides: Partial<StdioServerConfig> = {}): StdioServerConfig {
  return {
    transport: "stdio",
    command: process.execPath,
    args: [path.join(import.meta.dir, "fixtures", "stdio-server.mjs")],
    ...overrides,
  };
}

function text(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content;
  return content?.[0]?.text ?? "";
}

async function waitForStopped(): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await daemonStatus(mainPath);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("daemon did not stop");
}

async function startFakeDaemon(): Promise<void> {
  await fs.mkdir(path.dirname(daemonSocketPath()), { recursive: true });
  fakeDaemon = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (text.includes('"op":"hello"')) {
        writeJsonLine(socket, {
          ok: true,
          protocolVersion: 0,
          result: { protocolVersion: 0, version: "old" },
        });
      }
      if (text.includes('"op":"stop"')) {
        writeJsonLine(socket, { ok: true, result: { stopping: true } });
        void stopFakeDaemon();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    fakeDaemon?.once("error", reject);
    fakeDaemon?.listen(daemonSocketPath(), () => {
      fakeDaemon?.off("error", reject);
      resolve();
    });
  });
}

async function stopFakeDaemon(): Promise<void> {
  const server = fakeDaemon;
  fakeDaemon = undefined;
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(daemonSocketPath(), { force: true }).catch(() => {});
}

async function startHttpFixture(): Promise<{ url: string; sessions: (string | null)[] }> {
  const sessions: (string | null)[] = [];
  httpFixture = http.createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }

    const body = await readRequestBody(request);
    const message = JSON.parse(body) as { id?: string | number; method: string };
    sessions.push(request.headers["mcp-session-id"]?.toString() ?? null);

    if (message.method === "notifications/initialized") {
      response.writeHead(202, { "mcp-session-id": "session-1" }).end();
      return;
    }

    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" },
          }
        : message.method === "tools/list"
          ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: "http-ok" }] };

    response
      .writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "session-1",
      })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });

  await new Promise<void>((resolve, reject) => {
    httpFixture?.once("error", reject);
    httpFixture?.listen(0, "127.0.0.1", () => {
      httpFixture?.off("error", reject);
      resolve();
    });
  });
  const address = httpFixture.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind.");
  return { url: `http://127.0.0.1:${address.port}/mcp`, sessions };
}

async function stopHttpFixture(): Promise<void> {
  const server = httpFixture;
  httpFixture = undefined;
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
