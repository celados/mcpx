---
type: Specification
title: MCP Runtime Structural Upgrade
description: >
  Proposed executable contract for moving registry, credentials, sessions,
  authentication, and caller-owned Calls behind one user-local MCP Runtime.
status: accepted
version: 1
issues: [16]
---

# MCP Runtime Structural Upgrade

## Status and Sources

This specification is the authority for production implementation. It
supersedes the architectural assumptions in `docs/mcpxd-bdd.md` and
`docs/mcpxd-v2-bdd.md`; their verified transport and rendering scenarios remain
regression evidence.

Normative decisions:

- `docs/adr/0001-mcpxd-is-the-user-local-mcp-runtime.md`
- `docs/adr/0002-runtime-is-the-sole-declared-registry-writer.md`
- `docs/adr/0003-separate-declared-and-observed-state.md`
- `docs/adr/0004-single-flight-authentication-per-credential-identity.md`
- `docs/adr/0005-cli-disconnect-cancels-its-call.md`
- `docs/adr/0006-each-call-owns-its-lifecycle.md`
- `docs/adr/0007-authentication-is-explicit.md`
- `prototypes/mcp-cancellation/findings.md`
- GitHub Issue #16

## Required Outcomes

1. The CLI Adapter is short-lived. It discovers command shape from the MCP
   Runtime, submits one operation, renders frames, and exits after its terminal
   frame without retaining MCP transports, OAuth servers, timers, workers, or
   signal handlers.
2. The MCP Runtime is the only process that coordinates Calls, MCP sessions,
   Credential Identities, Authentication Flows, and command-driven registry
   writes.
3. A Call is caller-owned from acceptance through exactly one terminal outcome.
   Disconnect cancels only that Call and never evicts a healthy shared MCP
   session.
4. Ordinary Calls never start authentication. An unusable Credential Identity
   produces `reauth-required`; explicit `mcpx @refresh` is the only operation
   that may start or join an Authentication Flow.
5. Declared Registry, Credential Store, Schema Cache, Active State, and any
   Durable Operational State remain distinct.

## Product Contract

### Ordinary Call

- A Call with usable credentials may be queued and executed.
- A Call with missing, expired, rejected, or otherwise unusable credentials
  terminates with error code `reauth-required`.
- The Call does not open a browser, prompt for OAuth data, refresh a token, or
  wait for a future Authentication Flow.
- After the user runs `mcpx @refresh`, they explicitly retry the original Call.

### Explicit Refresh

- `mcpx @refresh` may refresh schemas and make Credential Identities usable.
- Concurrent refresh operations for the same Credential Identity join one
  Authentication Flow and observe the same terminal result.
- Exactly one browser authorization flow may exist per Credential Identity.
- Disconnect removes that refresh caller as a waiter. The final waiter leaving
  cancels the Authentication Flow and closes its local callback resources.

### Disconnect

- Disconnect before activation removes the queued Call without contacting the
  MCP server.
- Disconnect during execution requests MCP cancellation through the active
  Call's `AbortSignal`.
- Cancellation is best-effort and does not promise rollback of tool side
  effects.
- No result or error is written to a dead CLI connection.
- Detached Calls are unsupported.

## Runtime Protocol

The upgrade is a clean protocol break. Increment `DAEMON_PROTOCOL_VERSION` and
use the existing incompatible-daemon stop/start path; do not add V2 shims or
feature negotiation.

One CLI connection performs a handshake followed by one operation. Every
operation has a caller-generated `requestId`. Runtime frames repeat that ID:

```ts
type RuntimeFrame =
	| { requestId: string; kind: 'event'; event: RuntimeEvent }
	| { requestId: string; kind: 'result'; result: unknown }
	| {
			requestId: string
			kind: 'error'
			error: { code: RuntimeErrorCode; message: string }
	  }
```

The terminal frame is exactly one `result` or `error`. Events are optional and
precede the terminal frame. JSON Lines remains the framing format.

Supported operation intents:

- `registrySnapshot`: return declarations plus cached command schemas required
  to build the CLI router, without credential material or runtime session data.
- `call`: identify the registered server and tool by name and provide tool
  input. The CLI does not send server configuration or authorization headers.
- `addServer`: discover and persist one declaration through the Runtime.
- `removeServers`: remove declarations and unreferenced credential material
  through the Runtime.
- `refreshServers`: explicitly refresh schemas and, where required, start or
  join Authentication Flows.
- `status`: return redacted operational status.
- `stop`: stop the Runtime after coordinated cleanup.

## Module Design

### External Seam: MCP Runtime

The Runtime is one deep module. Its external interface accepts a validated
operation intent and a caller adapter. Callers do not coordinate credentials,
queues, sessions, persistence, or cancellation.

```ts
type RuntimeCaller = {
	id: string
	onDisconnect: (listener: () => void) => () => void
	requestInput: (
		request: RuntimeInputRequest,
		signal?: AbortSignal,
	) => Promise<unknown>
	send: (frame: RuntimeFrame) => Promise<void>
}

type McpRuntime = {
	handle: (intent: RuntimeIntent, caller: RuntimeCaller) => Promise<void>
}
```

The Unix socket is the production caller adapter. Tests use an in-memory caller
adapter. This is a real seam because both adapters exercise the same interface.
During explicit authentication, an `input-required` event may request manual
OAuth client data. The CLI responds on the same connection with a correlated
input frame; this does not count as a second operation. No other intent is
accepted after the first operation.
Terminal or disconnected CLI connections abort any active input provider, and
an Authentication Flow may transfer input ownership to another surviving
waiter for the same Credential Identity.

### Call Lifecycle

Each accepted tool invocation creates one internal Call object with:

- state `accepted | queued | active | terminal`;
- one caller-disconnect subscription;
- one `AbortController` created before queueing;
- one terminal result chosen by an idempotent transition.

Only the Call object may transition its state or remove its disconnect
subscription. The session queue grants permission to activate by asking the
Call to transition; it cannot mutate Call state directly.

Terminal transition order is normative:

1. atomically mark the Call terminal;
2. remove the caller-disconnect subscription;
3. release queue/session accounting;
4. send a terminal frame only if the caller is still connected.

This order prevents SDK 1.29.0 from emitting stale cancellation after normal
completion.

### Session Pool and Queue

The session pool owns MCP connections keyed by the existing stable server key.
Each managed session contains an explicit FIFO of Call entries and one drain
loop. Do not retain the current promise-chain queue, because a queued entry
cannot be removed from a chained promise without leaving hidden work behind.

The drain loop:

1. skips Calls already terminal because their caller disconnected;
2. asks the next Call to transition from queued to active;
3. invokes the MCP tool with the Call signal and existing timeout/progress
   options;
4. completes session accounting in `finally`;
5. continues with the next entry regardless of the prior outcome.

One MCP request remains active per server key. Cancellation, timeout, tool
failure, and late response do not evict the connection. Authentication failure,
protocol failure, explicit eviction, or connection closure may rebuild it under
their own policies.

Runtime shutdown closes admission before awaiting any store read or connection,
cancels active and queued Calls plus Authentication Flows, closes connections
that resolve late, and only then completes the stop operation.

### Credential Coordination

Credential coordination is internal to the Runtime:

- ordinary Calls perform a read-only usability check;
- unusable credentials return `reauth-required` without mutation;
- explicit refresh operations join a single in-memory promise per Credential
  Identity;
- each refresh caller is a waiter with independent disconnect cleanup;
- the final waiter leaving aborts the shared flow;
- successful rotation is persisted once before all waiters are released.

The existing cross-process token-cache lock is migration scaffolding, not the
final coordination model. Remove it only after every credential mutation has
moved behind the Runtime and regression tests prove one refresh across
concurrent CLI processes.

### State Stores

The Runtime owns three persistence modules with narrow internal interfaces:

- Registry Store: declarations selected by the user;
- Credential Store: OAuth tokens, client secrets, bearer material, raw HTTP
  headers, and stdio environment values;
- Schema Cache: rebuildable tool schemas, discovery timestamps, refresh status,
  and dirty markers.

Active Calls, waiters, queues, sessions, and Authentication Flows stay in
memory. No durable Call or detached job store is introduced.

## Persistence Migration

The current combined registry is migrated once by the Runtime:

1. acquire Runtime startup ownership;
2. read the current registry and credential files;
3. split declarations from cached schemas and refresh observations;
4. write each new store atomically;
5. retain one recoverable backup of the pre-migration registry;
6. start serving operations only after every write succeeds.

After migration, the Runtime uses only the new store contracts. The CLI has no
legacy read/write path, and the Runtime does not dual-write old and new shapes.

## SDK Cancellation Adapter

For an active Call, pass its signal in the third `Client.callTool` argument
alongside timeout and progress options.

MCPX-owned state determines whether the terminal cause is caller disconnect or
timeout. Do not infer it from SDK error code `-32001`, because SDK 1.29.0 uses
that code for both. A late-response `client.onerror` for a cancelled request is
diagnostic only and does not mark the session unhealthy.

Streamable HTTP cancellation sends an MCP cancellation request on the existing
session; it does not abort the transport-wide fetch controller. Do not close or
rebuild the HTTP transport solely because one Call was cancelled.

## Integration of Existing Dirty Work

- Preserve the OAuth callback server `unref()` mitigation until Runtime-owned
  Authentication Flow tests prove callback cleanup on success, error, timeout,
  and final-waiter disconnect.
- Preserve the concurrent refresh regression fixture and its rotating-token
  behavior.
- Replace the cross-process token-cache lock only when Runtime sole-writer and
  single-flight tests cover the same race. Do not layer a second coordination
  mechanism over it indefinitely.
- Keep all OAuth and HTTP acceptance fixtures local. Never require a real
  Cloudflare, PostHog, or other remote MCP endpoint.

## Acceptance Criteria

### Issue #16 Process Lifecycle

- Launch at least five concurrent CLI processes against a deterministic local
  HTTP MCP fixture; every process preserves its output and exit code and exits
  within a bounded post-result deadline.
- Repeat for tool failure, caller cancellation, and broken output pipe.
- After every CLI terminal frame, no CLI-owned timer, listener, server, worker,
  pipe, or MCP transport keeps that CLI process alive.
- The shared Runtime may remain alive while idle but must not busy-spin.

### Caller-Owned Cancellation

- A queued Call whose socket closes never reaches the fixture.
- An active stdio Call whose socket closes emits `notifications/cancelled`,
  settles promptly, and leaves the same child usable.
- An active Streamable HTTP Call whose socket closes emits cancellation on the
  same session and leaves that session usable.
- Respect, ignore, late-response, response-race, and complete-before-disconnect
  outcomes preserve subsequent request correlation.
- Normal completion removes the disconnect listener before a later socket close
  can emit stale cancellation.

### Explicit Authentication and Single-Flight

- An ordinary Call with unusable OAuth credentials returns `reauth-required`
  without hitting an authorization or token endpoint and without opening a
  browser.
- Five concurrent explicit refresh CLI processes for one Credential Identity
  produce one token refresh or one interactive flow, persist one result, and all
  exit.
- Disconnecting one refresh waiter does not cancel the flow while another
  waiter remains.
- Disconnecting the final waiter closes callback resources and cancels the
  flow.
- A 401 invalidates usability, applies the existing session-eviction policy,
  and returns `reauth-required`; it does not start authentication.

### State Ownership

- CLI code has no command-driven write path to Registry Store, Credential
  Store, or Schema Cache.
- Registry snapshots never contain tokens, client secrets, raw headers, session
  IDs, stdio environment values, queues, or health state.
- Migration preserves declarations and cached command availability while
  splitting their storage.
- Interrupted migration leaves the pre-migration data recoverable and never
  exposes a partially migrated runtime.

### Regression Gates

For every implementation ticket:

1. write a failing test through the owning module interface;
2. run the focused test;
3. run the relevant integration suite;
4. run the full test suite and typecheck;
5. run formatter checks and `git diff --check`.

The final upgrade additionally runs all local process-level, stdio, Streamable
HTTP, notification, OAuth, migration, and protocol-mismatch cases.

## Non-Goals

- concurrent MCP requests on one session;
- detached or durable Calls;
- background authentication initiated by an ordinary Call;
- real OAuth or remote MCP acceptance dependencies;
- preserving daemon protocol V2 compatibility;
- durable notification subscriptions;
- persisting Active State.
