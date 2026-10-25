---
type: Decision
title: A Challenge Is the OAuth Discovery Entry
status: accepted
---

# A Challenge Is the OAuth Discovery Entry

Whether a server needs OAuth is decided by the resource server's challenge, at any time, not by a probe when the server is added. A `401` (or `403 insufficient_scope`) on any request — tool listing or a Call — hands its `WWW-Authenticate` challenge to the MCP Runtime, which joins the single shared Authentication Flow for the server (ADR 0004, ADR 0008), authorizes with the challenge's `resource_metadata` and `scope`, records the server as OAuth in the same commit as its first grant, and retries the request once.

`@add` used to `GET` the server URL and freeze the result as the server's auth kind. A mixed-auth server — anonymous tools beside protected ones, such as `whiteboardanimation.ai` — answers that `GET` with `405`, so it was recorded as unauthenticated, and its spec-compliant challenge on a protected tool could only end in `reauth-required`. The probe guessed from the wrong request; the challenge is the server's own answer.

- `@add` no longer probes. It lists tools; a challenged listing records the server as OAuth and reports `auth-required` without opening a browser.
- The transport carries an mcpx `authProvider` whose `onUnauthorized` surfaces the challenge instead of running OAuth inside the request, so the Runtime keeps single-flight, Caller Input, progress events, and registry ownership (ADR 0002).
- OAuth itself — discovery, dynamic registration, PKCE, resource indicators, `iss` validation, refresh — is the official MCP SDK's `auth()`. mcpx supplies its `OAuthClientProvider`: per-server grants in the Credential Store, a loopback callback per sign-in, and the fixed `http://127.0.0.1:65245/callback` for manually registered clients. A refresh never opens the browser; a new sign-in never replays stored tokens or a client registered for another port, and replaces the stored grant only once it succeeds.
- A bearer credential that is challenged still fails with `reauth-required`; static credentials cannot be repaired by the Runtime.
