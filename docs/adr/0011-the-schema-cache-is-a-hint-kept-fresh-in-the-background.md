---
type: Decision
title: The Schema Cache Is a Hint, Kept Fresh in the Background
status: accepted
---

# The Schema Cache Is a Hint, Kept Fresh in the Background

MCP gives a client no cheap way to ask whether a server's tools changed: `tools/list` carries no version, ETag, or TTL, and `notifications/tools/list_changed` only reaches an open session. So mcpx does not try to learn the moment a schema changes. The Schema Cache is a hint for agents (`@schema`, generated commands); the server stays the authority on what a call accepts, and the cache is repaired wherever evidence of drift appears:

- **Unknown tool.** A CLI call to `<server>.<tool>` that the cache does not list re-syncs that server's schema before it is reported unknown.
- **Missing required field.** Input that misses a field the cached schema requires is judged again by the server's current schema before it is rejected.
- **Invalid Params.** A call the server rejects with JSON-RPC `-32602` (unknown tool, stale argument shape) re-lists the server in the background, at most once a minute.
- **Reconnect.** Every new session re-lists, in the background, a schema older than an hour.
- **`tools/list_changed`.** A notification during a call re-lists, as before.
- **Sweep.** mcpxd re-lists every schema older than a week when it starts and daily while it lives. mcpxd is the one MCP Runtime per user (ADR 0001) and each server has at most one listing in flight, so the sweep is exclusive without a lock file.

The first two are interactive: someone is waiting, so they may authorize like any Call (ADR 0008). Background listings never open a browser or ask for input; a credential that is unusable is recorded as `reauth-required` on the cached entry and left for the next real Call, and a failure keeps the last good tools.

This removes `@refresh`, the last remnant of [ADR 0007](0007-authentication-is-explicit.md): authorization already repairs itself during Calls (ADR 0008), signing in again is `@login` (ADR 0010), and schemas no longer need a manual trigger. `@add`, `@login`, and the CLI's re-sync share one internal `syncSchemas` Runtime operation (protocol 4).
