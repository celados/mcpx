---
type: Decision
title: Authentication Is Explicit
status: accepted
---

# Authentication Is Explicit

An ordinary Call never starts an Authentication Flow. When its Credential Identity is unusable, the MCP Runtime returns `reauth-required`; only an explicit `mcpx @refresh` operation may start or join the single shared flow, so agent and script invocations cannot unexpectedly open a browser or wait for interactive input.

When a provider requires a manually registered OAuth client, the Runtime sends a typed Caller Input request on the active `@refresh` connection. The CLI Adapter owns terminal prompting only; the Runtime owns metadata discovery, single-flight coordination, callback lifetime, token exchange, and persistence. The daemon never reads its ignored stdin, and the CLI never becomes an authentication state machine.

Caller Input is independently cancellable. If its caller disconnects while another waiter remains, the Authentication Flow offers the input request to a surviving waiter; Runtime shutdown aborts the flow and the CLI prompt signal before returning its terminal outcome.
