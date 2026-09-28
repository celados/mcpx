---
type: Decision
title: Calls Wait for Shared Authorization
status: accepted
supersedes: 0007-authentication-is-explicit.md
---

# Calls Wait for Shared Authorization

When a Call's Credential Identity is unusable, the MCP Runtime makes it usable instead of returning `reauth-required`: it refreshes the token silently when a refresh grant exists, and otherwise starts or joins the single shared browser Authentication Flow (ADR 0004). The Call waits for that flow, bounded by the flow's 5 minute timeout, and then proceeds. A 401 from the server replaces the credential the same way and retries the request once, because a rejected request was never executed.

[ADR 0007](0007-authentication-is-explicit.md) returned `reauth-required` for every unusable credential, which treated a non-interactive token refresh like an interactive login: routine hourly expiry failed ordinary Calls until the user ran `mcpx @refresh`. The recoverable case now recovers, and the interactive case waits rather than failing.

- Authorization runs before the Call is queued, so the wait consumes neither the tool timeout nor the session queue.
- The Runtime's stderr is detached, so every waiter receives Authentication Flow progress, including the authorization URL, as `progress` events; late joiners receive the latest one. The CLI Adapter renders them on stderr.
- Caller Input still flows only through a caller that can prompt. When the adapter cannot prompt (no terminal), the flow fails at once with `reauth-required` instead of waiting out the timeout.
- `reauth-required` now means the Runtime tried and could not authorize; `timeout` means nobody completed the browser step in time.
