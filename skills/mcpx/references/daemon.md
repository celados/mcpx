# mcpxd — Reference

mcpx runs a user-local background daemon (`mcpxd`) that keeps MCP server
sessions warm across separate `mcpx` invocations. As an agent calling mcpx
tools you normally do not need to think about it: the daemon is started on
demand, shuts down when idle, and is transparent to the call surface described
in the main SKILL.

This reference exists for the cases where daemon state is the cause of
unexpected behavior. Use it before filing an issue.

## Inspect daemon state

```bash
mcpx @daemon status --raw
```

Returns JSON with:

- `pid` — daemon process id
- `protocolVersion` — IPC protocol version
- `version` — mcpx version that started the daemon
- `activeServers` — number of pooled MCP sessions
- `servers[]` — one entry per pooled session:
  - `serverKey` — stable hash of launch parameters; same key = shared session
  - `transport` — `"stdio"` or `"http"`
  - `labels` — registry names attached to this session (multiple names may share one session if launch parameters are identical)
  - `pid` (stdio) — child process id
  - `url` (http) — redacted endpoint, host + path only
  - `activeCalls` / `queuedCalls` — concurrency snapshot
  - `idleMs` — how long since the last call returned
  - `evictCount` — how many times this session was rebuilt (auth refresh, 401, retained-session-id rejection)
  - `hasRetainedSessionId` — whether the daemon is holding a server-issued `mcp-session-id` for the next rebuild
  - `sessionIdHash` — short sha256 prefix of the retained session id, for diagnostic correlation only (raw id is never exposed)

## Reset the daemon

```bash
mcpx @daemon stop
```

Closes all daemon-managed MCP sessions and exits the daemon. The next `mcpx`
call cold-starts a fresh daemon. Use this when a session appears stuck and the
issue does not reproduce against a fresh process.

## Logs

```
~/.agents/mcpx/logs/
  daemon.log              # daemon lifecycle and IPC errors
  <serverKey>.stderr.log  # captured child stderr per session
```

Logs are capped at ~10MB with two retained rotations (`.1`, `.2`). Look here
when a tool call fails with no useful CLI output.

## When daemon state likely matters

- A tool call fails with an authentication error immediately after credentials
  were rotated, and the failure persists past one retry.
- `evictCount` rises rapidly between calls on the same registered server (token
  thrashing or session-id rejection loop).
- Two registry entries with identical launch parameters appear as separate
  sessions in status (key derivation may not match expectation).
- Tool schema in the project does not match the live MCP server's tools and
  `mcpx @refresh` does not converge.

In all other cases prefer filing an issue with the command, input, and any
relevant log excerpt at https://github.com/AIGC-Hackers/mcpx/issues.

## What this reference deliberately does not cover

- How to install or upgrade `mcpxd`. It ships inside `mcpx` and is started on
  demand. Users do not run it directly.
- IPC protocol details, session key derivation logic, eviction semantics.
  See the design BDD in `docs/mcpxd-v2-bdd.md` for the contract.
- Configuration knobs (idle TTL, eviction deadline). These are constants in
  the current release.
