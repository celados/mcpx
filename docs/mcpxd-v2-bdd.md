# mcpxd V2 BDD Spec - HTTP routing and first-class notifications

V2 extends V1 in three orthogonal directions:

1. Route HTTP MCP servers through the daemon (session-id preservation + connection reuse).
2. Surface MCP server-pushed notifications via per-call buffering + sentinel rendering.
3. Handle OAuth token refresh through an explicit `evictSession` IPC op.

V1 contract is preserved. V2 is a protocol bump (`DAEMON_PROTOCOL_VERSION = 2`).

Design discussion: #8. Implementation spec: #9. V1 spec remains in `docs/mcpxd-bdd.md`.

## Reference Cases

- HTTP: `https://mcp.posthog.com/mcp` for real-world benchmark; fake HTTP MCP server fixture for deterministic CI.
- Notifications: fixture stdio/HTTP server emitting `notifications/progress`.
- OAuth: simulated by fake HTTP MCP server returning 401 on demand.

## Non-Goals For V2

- No interactive OAuth flow inside the daemon. CLI remains the auth source of truth.
- No client-driven cancellation. `notifications/cancelled` forwarding deferred to V2.5.
- No daemon-side writes to `servers.json`. Daemon may signal `toolsChanged: true`; CLI writes config.
- No long-lived notification subscription (agent listening continuously for `tools/list_changed`). Deferred to V3+.
- No changes to MCP tool result shape itself.
- No concurrent calls over the same HTTP session. Daemon serializes per `serverKey`, matching V1 stdio. Concurrent calls with progress-token routing are deferred to V3+.

## Daemon Contract - V2 Deltas

### Concurrency Model

V2 inherits V1's per-`serverKey` serial queue for both stdio and HTTP. A single HTTP session handles at most one in-flight tool call.

Consequences:

- Notification attribution is unambiguous: any notification arriving while call X is in flight belongs to call X's buffer.
- No `progressToken -> callId` table is required.
- Session-scoped notifications (`tools/list_changed`, `resources/list_changed`) attach to whichever call is currently in flight. Idle `tools/list_changed` may be retained as a session dirty flag and reported on the next call; other idle notifications are discarded.

The MCP spec (rev `2025-11-25`) permits concurrent JSON-RPC requests via request ids, but V2 explicitly opts out for queue, timeout, and eviction simplicity. Concurrent calls per HTTP session, with explicit progress-token routing and session-level notification fan-out, are deferred to V3+.

### Server Key

Stdio key: unchanged from V1.

HTTP key:

```ts
hash({
  type: "http",
  url,
  authKind: auth?.kind,
  authRef: auth?.env ?? auth?.tokenKey ?? null,
});
```

Resolved runtime headers (Authorization token value) do not participate in the key. Token refresh therefore does not fragment sessions; `evictSession` is the explicit mechanism.

### IPC Protocol

```ts
const DAEMON_PROTOCOL_VERSION = 2;

type ClientMessage =
  | { op: "hello"; protocolVersion: 2; clientVersion: string }
  | {
      op: "listTools";
      callId: string;
      serverName: string;
      serverKey: string;
      server: ServerConfig; // stdio | http
      headers?: Record<string, string>;
    }
  | {
      op: "call";
      callId: string;
      serverName: string;
      serverKey: string;
      server: ServerConfig;
      headers?: Record<string, string>;
      toolName: string;
      input: Record<string, unknown>;
      notificationMode?: "buffer" | "discard";
    }
  | { op: "status" }
  | { op: "stop" }
  | {
      op: "evictSession";
      serverKey: string;
      reason?: "auth-refreshed" | "unauthorized" | "manual";
    };

type DaemonMessage =
  | {
      ok: true;
      protocolVersion?: 2;
      result?: unknown;
      notifications?: McpNotification[];
      toolsChanged?: boolean;
    }
  | { ok: false; error: { code: string; message: string } };

type McpNotification =
  | { method: "notifications/progress"; params: ProgressParams; aggregatedCount?: number }
  | { method: "notifications/tools/list_changed" }
  | { method: "$oversize"; params: { savedTo: string } }
  | { method: string; params?: unknown };
```

JSON Lines transport unchanged.

### Status Response Extension

```ts
type ServerStatus = {
  serverKey: string;
  transport: "stdio" | "http";
  labels: string[];
  pid?: number | null;
  url?: string;
  activeCalls: number;
  queuedCalls: number;
  idleMs: number;
  evictCount: number;
  hasRetainedSessionId: boolean;
  sessionIdHash?: string;
};
```

The raw session id is never exposed externally. `sessionIdHash` is for diagnostic correlation only.

## Feature: HTTP Session Factory

**Scenario: warm HTTP session reuse within TTL**

- Given an HTTP MCP server is registered with OAuth token in cache
- And `mcpxd` is running
- When the user runs a tool call on that server
- Then the daemon creates a `StreamableHTTPClientTransport` with resolved headers
- And keeps the `Client` and transport in the session pool keyed by HTTP server key
- When the user runs another tool call on the same server within idle TTL
- Then the same `Client` is reused without reconstructing transport
- And any `mcp-session-id` issued by the server is preserved across calls

**Scenario: HTTP server key isolates per auth reference**

- Given two registry entries with the same URL but different `auth.env` references
- When the user calls tools on each
- Then two distinct sessions exist in the daemon pool

**Scenario: HTTP server key ignores resolved token value**

- Given an HTTP server uses `bearer` auth from env `FOO_TOKEN`
- And the env value is rotated mid-day
- When subsequent calls happen
- Then the server key is unchanged
- And the same session entry is used, subject to eviction policy

## Feature: OAuth Token Refresh Eviction

**Scenario: CLI evicts before next call after token refresh**

- Given an HTTP server session is warm in the daemon
- And the CLI's `resolveHeaders()` detects token expiry
- And the CLI refreshes the token via existing token-cache flow
- When the CLI sends `{ op: "evictSession", serverKey, reason: "auth-refreshed" }`
- Then the daemon drains the in-flight queue
- And closes the transport
- And drops `lastSessionId` for that session entry
- And increments `evictCount`
- And responds `{ ok: true, result: { evicted: true } }`
- When the CLI sends the next `call` with refreshed headers
- Then the daemon rebuilds `StreamableHTTPClientTransport` with `{ requestInit.headers: <new> }`
- And starts a fresh server-side session
- And the call succeeds

**Scenario: daemon self-evicts on 401 mid-call**

- Given an HTTP server session is warm in the daemon
- And the server returns 401 to an MCP request mid-call
- Then the daemon classifies this as `reason: "unauthorized"`
- And the daemon evicts the session (drain, close, retain `lastSessionId`)
- And the original call fails with an unauthorized error
- And the CLI's existing reauth-required handling is triggered
- And after CLI refresh + next call, the session is rebuilt as in the prior scenario

**Scenario: server rejects retained session id during rebuild**

- Given a session was evicted and rebuild was attempted with `lastSessionId`
- When the HTTP server responds with 404 on the first request to that session id
- Then the daemon drops `lastSessionId` from the session entry
- And establishes a fresh session
- And the call succeeds or fails for unrelated reasons
- And `evictCount` is not incremented for this transition

**Scenario: evict on unknown server key is idempotent**

- Given no session exists for `serverKey = X`
- When the CLI sends `{ op: "evictSession", serverKey: "X" }`
- Then the daemon responds `{ ok: true, result: { evicted: false } }`
- And does not error

**Scenario: evict on stdio server key is a no-op**

- Given an active stdio session for `serverKey = Y`
- When the CLI sends `{ op: "evictSession", serverKey: "Y" }`
- Then the daemon responds `{ ok: true, result: { evicted: false, reason: "stdio" } }`
- And does not close the stdio session

**Scenario: evict deadline times out and returns control**

- Given an HTTP session has a slow in-flight call
- And the CLI sends `{ op: "evictSession", serverKey }`
- And the drain does not complete within `EVICT_DEADLINE_MS`
- Then the daemon responds `{ ok: true, result: { evicted: false, timedOut: true } }`
- And the CLI may retry evict or proceed
- And the daemon may continue the queued eviction asynchronously
- And the session entry remains in the pool, though the underlying transport may close later if the queued eviction completes

Default `EVICT_DEADLINE_MS = 5_000`.

**Scenario: concurrent calls during evict are queued behind the rebuild**

- Given an HTTP session is being evicted
- When new `call` ops arrive for the same serverKey before rebuild completes
- Then they are enqueued behind the rebuild step
- And not dispatched on the closing transport
- And not lost

## Feature: Notification Buffering and Rendering

**Scenario: 99% case - no notifications, no output change**

- Given a tool call that emits no notifications
- When the call returns
- Then the daemon response has no `notifications` field or an empty array
- And CLI rendering is identical to V1
- And no sentinel line is emitted

**Scenario: progress notification aggregation**

- Given a tool call that emits N `notifications/progress` messages with the same `progressToken`
- When N is greater than 2
- Then the daemon aggregates intermediate progress
- And the buffer contains exactly:
  - the first progress notification verbatim
  - the last progress notification verbatim with `aggregatedCount = N - 2`
- And no intermediate progress entries

Aggregation only applies to `notifications/progress` as defined by MCP `2025-11-25`.

**Scenario: unknown notification methods pass through verbatim**

- Given a tool call emits a notification with method not in known schemas
- Then the daemon buffers it verbatim
- And does not aggregate or modify

**Scenario: buffer cap triggers oversize file fallback**

- Given a tool call emits notifications totaling more than `NOTIFICATION_BUFFER_CAP_BYTES = 65_536` (64KB) or more than `NOTIFICATION_BUFFER_CAP_COUNT = 100`
- Then the daemon writes the full notifications array to a temp JSON file
- And replaces the daemon response notifications with:

```json
{ "method": "$oversize", "params": { "savedTo": "/tmp/mcpx-notifications-<hash>.json" } }
```

- And the hash is derived from `sha256(JSON.stringify(notifications))`
- And the file contents are complete JSON, not a truncated suffix

**Scenario: `tools/list_changed` signals CLI for write-back**

- Given an MCP server emits `notifications/tools/list_changed` during a call
- Then the daemon includes the notification in the response buffer
- And sets `response.toolsChanged = true`
- And the daemon does not modify `servers.json`
- When the CLI receives `toolsChanged: true`
- Then the CLI refreshes tools via the existing schema refresh path
- And writes the new tool schema to `servers.json`

**Scenario: idle `tools/list_changed` is carried to the next call**

- Given an HTTP session is warm and idle
- When the MCP server pushes `notifications/tools/list_changed`
- Then the daemon records the session schema as dirty
- And the next call response sets `toolsChanged = true`
- And the dirty marker is reset after it is reported

**Scenario: other notification between calls is discarded**

- Given an HTTP session is warm and idle
- When the MCP server pushes a notification that is not `notifications/tools/list_changed`
- Then the daemon discards it
- And no buffer accumulates
- And the next call's buffer starts empty

Rationale: per-call buffer scoping. Long-lived subscription belongs to V3+.

## Feature: Output Rendering

CLI handles `response.notifications` rendering. Default output prefers one merged TOON document
when the result can be viewed as a single object.

**Scenario: default structured output merges notifications**

- Given a tool call returned `structuredContent` and non-empty notifications
- And output mode is default TOON
- Then CLI prints one TOON object to stdout
- And the object includes `@notifications: [...]`
- And no trailing sentinel line is emitted

**Scenario: default JSON text output merges notifications**

- Given a tool call returned exactly one text content item
- And that text parses as a JSON object
- And output mode is default TOON
- Then CLI parses the JSON text and prints one TOON object
- And the object includes `@notifications: [...]`

**Scenario: default fallback output keeps trailing sentinel**

- Given a tool call returned non-JSON text, binary, or mixed content with notifications
- And output mode is default TOON
- Then CLI prints the normal result rendering to stdout
- And appends a final line: `@notification: [{...}, {...}]`

**Scenario: oversize notifications render as a saved-file message**

- Given daemon response notifications is `[ { "method": "$oversize", "params": { "savedTo": P } } ]`
- And default output can merge into an object
- Then the merged object includes `@notifications: "notifications oversize, saved to P"`
- When default output cannot merge into an object
- Then the fallback sentinel line reports the same saved-file path

**Scenario: raw structured output uses envelope when notifications present**

- Given a tool call returned `{ result: <structured>, notifications: [...non-empty] }`
- And the user passed `--raw` and the result is structured (not text content)
- Then CLI prints `{ "result": <structured>, "notifications": [...] }` as a single JSON document to stdout
- When notifications is empty
- Then CLI prints the raw structured result as in V1 (no envelope)

**Scenario: raw text output appends trailing sentinel**

- Given a tool call returned text content with notifications
- And the user passed `--raw`
- Then CLI prints the text content to stdout
- And appends a final line: `@notification: [...]`

**Scenario: stderr is never used for notifications**

- Given any tool call returns notifications
- Then nothing is written to stderr because of notifications
- And stderr is reserved for diagnostics, TUI prompts, and progress feedback (non-data channels)

### Sentinel Defaults and Escalation

Default sentinel: `@notification:`.

Escalation path, recorded for future use but not implemented in V2 initial release:

```text
L0 (default): @notification:
L1:           @@@notification:
L2:           \x1e@notification:
```

L1 / L2 are triggered only if a real-world collision is reported.

## Feature: Protocol Mismatch and Upgrade

V1 -> V2 follows the existing V1 protocol mismatch path:

- V2 CLI connects to V1 daemon -> handshake reports `protocol-mismatch`
- CLI calls existing `stopIncompatibleDaemon` path
- CLI spawns V2 daemon
- Subsequent calls proceed on V2

V2 protocol negotiation is identical to V1 (single integer version, no per-feature flags). If V3 needs feature negotiation, add a `capabilities` field to `hello`.

## Test Strategy

### Unit tests

- HTTP server key derivation: same URL + different auth ref -> different keys; same URL + rotated token value -> same key.
- Notification aggregation: progress with N=1, N=2, N=10, mixed methods.
- Buffer cap: oversize file fallback marker inserted at cap.
- Notification rendering for merged default TOON / fallback sentinel / raw structured / raw text.

### Integration tests

The fake HTTP MCP server fixture must support:

- Configurable response for `mcp-session-id` (issue / require / 404 on mismatch).
- Configurable 401 injection mid-call.
- Configurable notification emission during tool calls.
- Configurable progress notification stream.

Cases:

1. HTTP session reuse within TTL (same `mcp-session-id` reused).
2. CLI evict + rebuild with retained `lastSessionId` accepted by server.
3. CLI evict + rebuild with retained `lastSessionId` rejected (404) -> fresh session.
4. Daemon 401 self-eviction.
5. Notification buffer flush in response.
6. Progress aggregation.
7. Buffer oversize with saved-file marker.
8. `tools/list_changed` -> response signals CLI; CLI writes back.
9. Idle `tools/list_changed` carries to the next call.
10. Other notifications between calls are discarded.
11. Evict deadline timeout returns `timedOut: true`.

### Acceptance tests

- Real `mcp.posthog.com` HTTP server (benchmark only, gated, not in CI default).
- Existing stdio fixture extended with progress notification tool.
- Filesystem MCP unchanged (still V1 stdio path, now via V2 daemon).

### Real Server Quirks

PostHog (`https://mcp.posthog.com/mcp`) is the V2 gated benchmark target because it exercises
real OAuth, Streamable HTTP session ids, and a large tool schema.

- PostHog issues `mcp-session-id` during initialize and accepts it across subsequent POST calls.
- The SDK may open a GET SSE stream that PostHog answers with HTTP 500 while POST tool calls still
  succeed. V2 must not treat that observed GET failure as evidence that POST session reuse is broken.
- PostHog retained sessions appear coupled to the access token that created them. After OAuth refresh,
  rebuilding a transport with the previous `mcp-session-id` can fail with `INVALID_API_KEY`; mcpxd
  must not retain session ids across `auth-refreshed` eviction. If another retained rebuild is
  rejected with `INVALID_API_KEY`, mcpxd must drop the retained id, rebuild fresh, and retry the
  original call once.

## Spike Results

- Spike A (#14): SDK `1.29.0` reflects mutations to the original `requestInit.headers` object on the next `transport.send()`. Replacing only a local variable does not affect transport headers.
- Spike B (#13): retained `sessionId` is sent by a rebuilt transport; if the server rejects the retained session id with 404, the SDK throws and does not auto-clear/retry.

Implementation consequences:

1. V2 can use daemon-owned mutable headers as the normal token-refresh fast path.
2. `evictSession` drops `lastSessionId` for `auth-refreshed`; manual eviction may retain it.
3. On retained-session rejection, mcpx must explicitly drop `lastSessionId`, construct a fresh transport, and retry/fail according to original call semantics.

## References

- V1 BDD: `docs/mcpxd-bdd.md`
- Design discussion: #8
- V2 BDD issue: #9
- V2.5 cancel + disconnect: #10
