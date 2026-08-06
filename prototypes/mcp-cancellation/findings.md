---
type: Research
title: MCP Call Cancellation Findings
description: Observed SDK 1.29.0 cancellation behavior and a proposed MCPX adapter boundary.
---

# MCP Call Cancellation Findings

## Evidence Boundary

- Runtime: Bun `1.3.14` and `@modelcontextprotocol/sdk@1.29.0`.
- The SDK version is exact in `bun.lock`. The repository does not currently pin
  a Bun version in `package.json`, `.tool-versions`, or a mise config, so Bun
  `1.3.14` is the observed executor version rather than a repository-declared
  pin.
- Fixtures are a spawned local stdio process and a loopback-only Bun HTTP
  server. No OAuth or remote MCP endpoint is involved.
- Raw observations: `evidence.json`.
- Reproduction: `bun run prototype:cancellation:evidence`.

The fixture deliberately controls both compliant and adversarial server
outcomes. SDK implementation checks use the installed files at:

- `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts:61`
- `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:636`
- `node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:288`

## Confirmed SDK Behavior

1. `RequestOptions.signal` is the caller cancellation option for
   `Client.callTool`. Aborting it removes the response/progress handlers, clears
   the timeout, sends `notifications/cancelled` with the original JSON-RPC
   `requestId` and stringified abort reason, and rejects the caller promptly.
2. SDK 1.29.0 rejects an aborted call with `McpError` code `-32001`
   (`RequestTimeout`), not an `AbortError`, unless the abort reason is already an
   `McpError`. This conflicts with the `RequestOptions.signal` declaration text
   that says an `AbortError` is raised. MCPX must not classify cancellation from
   the thrown error code alone.
3. `timeout` reaches the same internal cancellation path, including emitting
   `notifications/cancelled`, but it represents deadline expiry rather than CLI
   ownership loss. It is not a substitute for the caller signal.
4. Stdio cancellation does not close the child transport. A server can respect
   cancellation, ignore it, or race a response; a second call remains correctly
   correlated in every observed case.
5. An ignored or racing late response is discarded because its response handler
   was removed. SDK 1.29.0 reports it through `client.onerror` as an unknown
   message ID, but subsequent calls remain usable.
6. Streamable HTTP request sends use the transport's single lifecycle
   `AbortController`, not `RequestOptions.signal`. Caller cancellation therefore
   does not abort the original fetch. It sends a separate
   `notifications/cancelled` POST on the same `mcp-session-id`; the session and
   transport remain reusable. Only transport `close()` aborts the transport-wide
   controller.
7. In every HTTP scenario, calls before and after a late response reused
   `local-session`. The fixture observed `originalRequestAborted: false` when it
   received cancellation.
8. The SDK does not remove the request's abort listener after a normal response.
   Aborting the controller after fulfillment still emits a stale
   `notifications/cancelled` for the completed request. The server safely saw it
   as non-pending, but MCPX should prevent it.
9. A cancellation notification has no protocol acknowledgement. In this report,
   “acknowledge” means the server observes the notification and stops work. The
   SDK server implementation maps an incoming cancellation to the matching
   request handler's `AbortSignal`.

## Outcome Matrix

| Server outcome                   | Caller result                                    | Late response                         | Same connection reusable            |
| -------------------------------- | ------------------------------------------------ | ------------------------------------- | ----------------------------------- |
| Respects cancellation            | Rejected promptly with `McpError(-32001)`        | None                                  | Yes                                 |
| Ignores cancellation             | Rejected promptly with `McpError(-32001)`        | Reported as unknown ID                | Yes, before and after late response |
| Responds as cancellation arrives | Cancellation wins in this deterministic ordering | Reported as unknown ID                | Yes                                 |
| Completes before cancellation    | Fulfilled normally                               | A stale cancellation is still emitted | Yes                                 |

Observed cancellation settlement was 15–20ms in four consecutive local runs.
That timing demonstrates prompt settlement under this fixture; it is not an API
latency guarantee.

## Recommended MCPX Policy

Use one caller-owned `AbortController` per Call, independent of the shared MCP
connection:

```ts
type CallCancellation = {
	signal: AbortSignal
	wasCallerDisconnected: () => boolean
}
```

- Create the controller when the Runtime accepts the Call, so the same signal
  can remove a queued Call or cancel an active SDK request.
- While the Call is non-terminal, listen to the originating CLI socket's
  `close` event and abort with a stable internal reason such as
  `originating CLI socket closed`.
- Pass `signal` alongside the existing timeout in the third `callTool` argument.
- Mark the Call terminal and remove the socket listener before returning or
  writing a result. This prevents SDK 1.29.0 from emitting stale cancellation
  after normal completion.
- Determine the Call's terminal state from MCPX-owned state
  (`wasCallerDisconnected()` or an explicit cancellation cause), not from SDK
  error code `-32001`, because timeout and caller abort share that code.
- Never write a result to a closed socket. Treat cancellation as best-effort and
  do not claim rollback of tool side effects.
- Do not evict a stdio process, HTTP session, or transport solely because one
  Call was cancelled or produced a late-response `client.onerror`. Eviction
  remains a connection-health decision.

The current Runtime has no socket lifecycle hook in `handleConnection`, and
`callToolOnConnectedSession` only passes timeout/progress options. Production
implementation should add the cancellation boundary there without moving
caller ownership into the shared `ManagedSession`.
