---
type: Decision
title: Adding Signs In, and @login Replaces a Grant
status: accepted
---

# Adding Signs In, and @login Replaces a Grant

`@add` is the user asking to use a server, so a challenged tool listing goes straight on to the shared Authentication Flow (ADR 0004) and then lists the tools: one command takes an OAuth server from unknown to callable. `mcpx @login "{ name }"` starts a new browser sign-in for a registered OAuth server even when its grant still works, which is how an account is switched.

[ADR 0009](0009-a-challenge-is-the-oauth-discovery-entry.md) kept `@add` from opening a browser because it was written when only explicit commands could (ADR 0007). [ADR 0008](0008-calls-wait-for-shared-authorization.md) already lets an ordinary Call open one, which left `@add` as the only entry that refused, and made switching accounts a `@remove` + `@add` detour whose only purpose was deleting the stored grant.

- `@add` still never probes; it lists tools, and only a challenged listing on a server without a configured bearer signs in. A failed sign-in keeps the registration and reports the failure; `@login` retries it.
- A sign-in skips the refresh grant and asks again for the previously granted scope. It replaces the stored grant only once the new one is earned (the existing interactive-mode guarantee), so an abandoned or failed `@login` leaves the old account working.
- The authorization URL carries OIDC `prompt=login`, so a browser still signed in to the old account cannot silently authorize it again. Authorization servers without OIDC ignore the parameter.
- `@login` on a bearer or stdio server fails: their credentials are declared, not earned, and change by re-adding.
- A sign-in that arrives while a refresh flow for the same Credential Identity is running joins that flow (ADR 0004) and gets its result; run `@login` again afterwards.
