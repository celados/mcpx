---
type: Specification
title: mcpxd BDD Spec
status: superseded
superseded_by: docs/specs/mcp-runtime-upgrade.md
---

# mcpxd BDD Spec

> Superseded for architecture and ownership. Retained only as historical regression evidence.

## Purpose

`mcpxd` is a user-local daemon for reusing stdio MCP server sessions across
separate `mcpx` CLI invocations. It is not a general process manager. Its only
owned problem is making registered `transport: "stdio"` servers fast and stable
enough for repeated agent tool calls.

HTTP MCP servers stay on the existing direct client path.

V1 does not route HTTP MCP servers through the daemon. HTTP connections also
have warm state, but their cold-start cost is mostly TLS/session setup and is
partly mitigated by the existing token cache. Stdio cold-start cost is process
spawn plus MCP initialization, which has no equivalent mitigation today.

## Reference Case

Use `@modelcontextprotocol/server-filesystem` as the primary integration case.
The upstream server is a practical stdio MCP server because it:

- starts from a command plus directory arguments;
- uses stdout for MCP JSON-RPC and stderr for diagnostics;
- exposes read-only and write-capable tools;
- keeps session state through allowed directories and optional MCP Roots.

The baseline command shape is:

```bash
mcpx @add --name filesystem \
  --transport stdio \
  --command bunx \
  --args -y \
  --args @modelcontextprotocol/server-filesystem \
  --args /tmp/mcpxd-filesystem
```

Tests may use a local fixture server for precise timing, crash, and concurrency
control. Filesystem remains the acceptance case for real stdio MCP behavior.

## Non-Goals For V1

- No PM2, launchd, or systemd dependency.
- No machine-wide or cross-user service.
- No HTTP server routing through the daemon.
- No automatic restart loop after a server crash.
- No parallel calls over the same stdio MCP session. This is a V1
  simplification, not an MCP protocol limit; JSON-RPC can support concurrent
  request ids, but serial calls make timeout, cancellation, and stderr
  attribution easier to reason about until daemon behavior is measured.
- No Roots client implementation unless separately specified.
- No server-pushed notification delivery beyond what is needed to complete the
  current request/response call.

## Daemon Contract

The CLI talks to `mcpxd` over a user-owned local IPC endpoint under
`~/.agents/mcpx/`. The endpoint handshake, not a pid file, is the source of
truth for daemon liveness.

Each managed stdio server has a stable server key derived from:

- command;
- args;
- env declarations as stored in the registry, not resolved runtime secret
  values;
- cwd when supported.

The registry name is a display label and status grouping hint, not part of the
server key. Two names with identical launch parameters may reuse the same child.
If a registry stores raw env values, changing that value changes the key. Secret
env references are preferred because they let token rotation avoid unnecessary
session churn.

The daemon owns:

- one MCP client session per active stdio server key;
- a serial promise queue per server key;
- `lastUsedAt` for idle cleanup;
- graceful close and forced kill fallback;
- daemon protocol version handshake.

The CLI is the source of truth for registry config. Each tool-call IPC message
carries the resolved stdio `ServerConfig` needed to launch the server. The
daemon does not read or watch `servers.json`, which keeps registry edits visible
on the next CLI invocation without extra reload logic.

The daemon listens on a Unix domain socket on POSIX systems. The directory
`~/.agents/mcpx/` must be created with `0700` permissions, and the socket must
reject connections from other uids where the platform exposes peer credentials.
On platforms without Unix sockets, the fallback IPC must provide the same
single-user access boundary.

V1 uses JSON Lines over the local IPC connection:

```ts
type ClientMessage =
	| { op: 'hello'; protocolVersion: 1; clientVersion: string }
	| {
			op: 'call'
			callId: string
			serverName: string
			serverKey: string
			server: StdioServerConfig
			toolName: string
			input: Record<string, unknown>
	  }
	| { op: 'status' }
	| { op: 'stop' }

type DaemonMessage =
	| { ok: true; protocolVersion?: 1; result?: unknown }
	| { ok: false; error: { code: string; message: string } }
```

If this protocol needs binary payloads later, replace JSON Lines with
length-prefixed JSON. Do not add ad hoc newline escaping.

## Feature: CLI Starts Daemon On Demand

Scenario: cold daemon start

- Given no `mcpxd` socket is accepting connections
- And the registry contains a stdio `filesystem` server
- When the user runs `mcpx filesystem list_allowed_directories --input '{}'`
- Then `mcpx` starts `mcpxd` detached
- And `mcpxd` starts the filesystem stdio process
- And the tool call succeeds
- And the response includes the configured allowed directory

Scenario: concurrent cold start

- Given no `mcpxd` socket is accepting connections
- When two CLI processes call stdio tools at the same time
- Then at most one daemon wins the socket bind
- And the losing CLI reconnects to the winning daemon
- And both calls complete without creating two live daemons for the same user

Scenario: stale socket file without live listener

- Given a daemon socket path exists
- And no process is accepting a valid handshake on that socket
- When the user calls a stdio tool
- Then the CLI removes the stale socket file
- And starts a new daemon
- And completes the call

Scenario: daemon died between calls

- Given a previous CLI call established a daemon
- And the daemon process has since exited
- When the user runs a stdio tool call
- Then the CLI detects no live socket
- And starts a new daemon
- And the call completes
- And stdio children from the dead daemon are not reused

Stdio child processes must not be launched detached from the daemon. If the
daemon dies, their stdin pipe closes; conforming stdio MCP servers should exit
on EOF. Tests should verify this with the fixture and filesystem server.

## Feature: Stdio Server Session Reuse

Scenario: warm server reuse within TTL

- Given `mcpxd` is running
- And the `filesystem` server has already handled one call
- When the user calls `filesystem list_allowed_directories` again before TTL expires
- Then the daemon reuses the same filesystem child process
- And the call succeeds

Scenario: server key change starts a new child

- Given an active `filesystem` child was started with directory A
- When the registry changes the same server name to use directory B
- Then the next call uses a different server key
- And the daemon starts a new child process
- And the old child is eligible for idle cleanup

Scenario: renamed registry entry can reuse the same child

- Given a stdio child was started from command, args, env declarations, and cwd
- When another registry entry uses a different server name with the same launch parameters
- Then the daemon derives the same server key
- And may reuse the existing child process

## Feature: Idle TTL Cleanup

Scenario: idle child exits after TTL

- Given a stdio server child has no active calls
- And its `lastUsedAt` is older than the configured TTL
- When the cleanup loop runs
- Then the daemon closes the MCP client
- And the child process exits
- And the server key is removed from the active pool

Scenario: active call is never killed by TTL

- Given a slow tool call is active
- And the server's previous `lastUsedAt` is older than TTL
- When the cleanup loop runs
- Then the daemon does not close or kill that child
- And cleanup waits until the call finishes and becomes idle

Scenario: daemon exits after all children are idle

- Given `mcpxd` has no active child processes
- And the daemon has been idle longer than `daemonIdleTTL`
- When the daemon cleanup loop runs
- Then it removes its socket
- And exits cleanly

Default child `idleTTL` is `15m`. Default `daemonIdleTTL` is `30m`. A future
registry field may allow a per-server override, but v1 should keep the global
defaults simple unless implementation evidence says otherwise.

## Feature: Serial Calls Per Server

Scenario: two calls to the same server are serialized

- Given a stdio fixture server has a slow tool
- When two CLI calls target the same server at the same time
- Then the daemon sends the second MCP call only after the first completes
- And both calls receive the correct response
- And no JSON-RPC messages are interleaved on the same stdio session

Scenario: calls to different servers do not block each other

- Given two different stdio server keys are active
- When one server is handling a slow call
- Then a call to the other server can complete independently

## Feature: Failure Handling

Scenario: missing command fails clearly

- Given a stdio server command does not exist
- When the user calls one of its tools
- Then the call fails with a launch error
- And the daemon does not keep a broken active server entry

Scenario: child exits during a call

- Given a stdio server child exits before returning a tool result
- When the user calls a tool
- Then the current call fails
- And the daemon removes that child from the active pool
- And the next call may cold-start a new child

Scenario: stderr diagnostics do not corrupt MCP output

- Given a stdio server writes logs to stderr during startup and tool calls
- When the user calls a tool
- Then the MCP stdout protocol remains valid
- And stderr diagnostics are captured in daemon logs
- And normal `mcpx` output contains only the tool result unless debug output is requested

Scenario: daemon crash recovery prefers cold start

- Given the daemon process terminates unexpectedly
- When the user calls a stdio tool
- Then the CLI starts a new daemon
- And the call is served by a newly launched stdio child
- And no direct-client fallback is used unless daemon startup itself fails clearly

## Feature: Schema Refresh

Scenario: missing stdio schema refresh goes through daemon

- Given a registered stdio server has no cached tools
- When the CLI needs to build the router or run `@refresh`
- Then schema discovery uses `mcpxd` for stdio servers when daemon mode is enabled
- And the CLI writes the discovered tools back to `servers.json`

Scenario: HTTP schema refresh bypasses daemon

- Given a registered HTTP server needs refresh
- When the CLI runs startup refresh or `@refresh`
- Then the existing HTTP refresh path is used
- And no daemon process is required

The daemon may keep an in-memory tool list for active stdio sessions, but the
CLI remains responsible for persisting registry schema updates. V1 ignores
server-pushed `tools/list_changed`; handling it belongs in a later notification
design.

## Feature: Daemon Control Plane

Scenario: daemon status

- Given `mcpxd` is running
- When the user runs `mcpx @daemon status`
- Then output includes daemon pid, protocol version, active server count, and server idle ages

Scenario: daemon stop

- Given `mcpxd` is running with active stdio children
- When the user runs `mcpx @daemon stop`
- Then the daemon closes all MCP clients
- And removes its socket
- And exits cleanly

Scenario: daemon server entrypoint

- Given the CLI starts the daemon process
- When it spawns `mcpx @daemon server`
- Then the process listens as `mcpxd`
- And there is no separate hidden `@daemon-server` command path

Scenario: protocol mismatch

- Given an existing daemon responds with an unsupported protocol version
- When the CLI connects
- Then the CLI asks the old daemon to stop
- And starts a compatible daemon
- And continues the original call
- And reports an error only if the old daemon cannot be stopped or replaced

The status command gets the daemon pid from the live socket response. V1 does
not rely on a persistent pid file for liveness; if a pid file is ever added, it
is diagnostic only.

## Logs

Daemon logs are predictable and bounded:

- `~/.agents/mcpx/logs/daemon.log` records daemon lifecycle and IPC errors.
- `~/.agents/mcpx/logs/<server-key>.stderr.log` records child stderr.
- Each log file is capped at `10MB` with two retained rotations.

Normal `mcpx` command output must not include daemon logs unless the user asks
for debug output.

## Test Strategy

Use three layers:

1. Unit tests for server key hashing, queue behavior, TTL decisions, and IPC
   message validation.
2. Integration tests with a deterministic local stdio fixture for crash, slow
   call, stderr, and TTL timing.
3. Acceptance tests with `@modelcontextprotocol/server-filesystem` for real
   stdio MCP startup, schema discovery, tool calls, and read/write behavior in a
   sandbox directory.

Filesystem acceptance should cover:

- `list_allowed_directories` returns the sandbox root;
- `write_file` creates a file inside the sandbox;
- `read_text_file` reads the same file across a later CLI invocation;
- a second call within TTL reuses the same child process;
- after TTL, a later call starts a new child process and still reads the file.

Stateful fixture acceptance should cover:

- an in-process counter increments across separate CLI invocations within TTL;
- the counter resets after the child is idle-cleaned and cold-started again;
- a slow stateful call serializes same-server calls but does not block a
  different server key.

## Open Decisions

- Whether V2 should allow concurrent in-flight calls over one stdio MCP session
  after request-id multiplexing and cancellation behavior are measured.
- Whether V2 should forward cancellation when the originating CLI disconnects
  mid-call. V1 does not expose a fake cancel operation.
- Whether V2 should surface MCP notifications. Two plausible options are
  tail-attached notifications for the active call, or write-through handling for
  schema-affecting notifications such as `tools/list_changed`.
- Env persistence: registry may support explicit `env`, but secret-by-reference
  is safer for long-lived daemon use and should be preferred in docs.
