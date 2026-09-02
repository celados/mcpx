---
type: Proposal
title: WebMCP Bridge — @webmcp.info / @webmcp.exec
description: >
  Expose Chrome's native WebMCP tool registry to mcpx agents as an aggregated
  browsing-state directory plus typed tool execution, without weakening the
  declared/observed state separation.
status: draft # draft | accepted | superseded
version: 0.1
generated: { by: omp/glm-5.3-flash, at: 2026-08-27T00:00:00Z }
tags: [webmcp, chrome, bridge]
---

# WebMCP Bridge

## Problem

WebMCP ([W3C WebML CG explainer](https://github.com/webmachinelearning/webmcp),
Chrome origin trial since Chrome 149) lets web pages register structured tools
via `document.modelContext.registerTool()`. Chrome mediates discovery and
execution. For desktop agents today the only sanctioned consumption path is
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
with `--categoryExperimentalWebmcp=true`, which exposes two generic primitives:

- `list_webmcp_tools(pageId)` — tools of one live page
- `execute_webmcp_tool(pageId, toolName, input)` — one typed call

Two structural gaps follow from the spec's design decisions (live-tab
registration, rejected static manifests):

- **Gap A (aggregate view)** — no endpoint answers "which open sites expose
  which tools". An agent must enumerate pages itself, fan out N list calls,
  and group by origin. Composable, just clumsy.
- **Gap B (persistent directory)** — no offline catalog, no launch URL/route
  metadata, no restore path after tab or browser death. Tool registrations die
  with their document. This gap cannot be closed from mcpx; see [Non-goals].

This proposal closes Gap A inside mcpx and gives Gap B an honest, explicitly
staleness-marked mitigation.

## Goals

1. One command that renders the browsing-state directory:
   origins → pageIds → declared tools with schemas.
2. Typed execution against a specific page without agents hand-rolling RPCs.
3. Optional bounded multi-step orchestration in one CLI invocation.
4. Errors that tell the agent exactly how to recover (re-run discovery), never
   silent empty results.

## Non-goals

- Closing Gap B. No persistent origin→tools directory is authored as protocol
  truth. Any historical record is explicitly staleness-marked observed history
  and never presented as current fact.
- Becoming a general browser-automation surface. Generic page navigation /
  screenshot / evaluate stay with the underlying server's raw tools.
- In-page JavaScript evaluation. Nothing in this bridge runs code in the page;
  every tool call crosses the browser-arbitrated `executeTool` contract.

## Design

### Server registration

chrome-devtools-mcp registers like any stdio server; `mcpxd` keeps the
session warm so the Chrome connection survives across CLI invocations:

```bash
mcpx @add '{
  name: "chrome-devtools",
  transport: "stdio",
  command: "npx",
  args: ["-y", "chrome-devtools-mcp@latest",
         "--categoryExperimentalWebmcp=true"]
}'
```

Environment prerequisites (user setup, not runtime logic):

- Chrome ≥ 150 with the WebMCP feature enabled
  (`chrome://flags/#enable-webmcp-testing`, or
  `--enable-features=WebMCP` when Chrome is launched by the server).
- To attach to an already-running instance instead of spawning its own:
  pass the existing debugger URL via `--browser-url`.
- Flag spelling follows upstream docs verbatim (`--categoryExperimentalWebmcp=true`);
  drift is checked at registration time, not string-guessed at call time.

The raw upstream tools remain reachable as `chrome-devtools.<tool>`; the new
commands are composition sugar over them, not a proxy that intercepts them.

### `mcpx @webmcp.info`

Renders the observed browsing-state directory. Implementation:

```text
pages   = chrome-devtools.list_pages()                       # [{pageId, url, title}]
groups  = groupBy(origin(url), pages)
for each page: tools[pageId] = list_webmcp_tools(pageId)     # parallel
output: one entry per origin
```

```yaml
# shape, illustrative
- domain: a.com
  pages:
    - pageId: 1
      url: https://a.com/console
      tools:
        - name: deploy_status
          description: ...
          inputSchema: { ... }
```

Semantics:

- Computed live on every invocation. This is pure observed state
  ([ADR-0002] declares only user intent; [ADR-0003] separates observed state)
  — nothing here enters the Declared Registry or Schema Cache.
- `pageId`s are ephemeral facts about the browsing session and are presented
  as such; they are meaningless across Chrome restarts.
- Empty tool lists are reported as empty lists, never omitted: the difference
  between "this page has no WebMCP tools" and "we did not look" matters to a
  planning agent.
- Parallelism across pages uses the runtime's normal call coordination
  ([ADR-0006]: each call owns its lifecycle). One slow/failing page degrades
  its own entry, not the whole report.

### `mcpx @webmcp.exec`

Typed single-tool execution:

```bash
mcpx @webmcp.exec '{ page: 1, tool: "deploy_status", input: { env: "prod" } }'
```

- Thin composition over `execute_webmcp_tool(pageId, toolName, input)`.
- Stale-page failures from the upstream (tab closed, navigated away) pass
  through as structured errors carrying the failed pageId and a recovery hint:
  re-run `@webmcp.info` and re-select. The bridge never swallows this into an
  empty success — the agent must be able to distinguish wrong-target from
  no-op.
- Timeout policy inherits the standard `MCPX_TOOL_CALL_TIMEOUT_MS`.

### Batch steps (phase 1)

Sequential multi-call orchestration with variable capture, still fully
declarative:

```bash
mcpx @webmcp.exec - <<'JSON5'
{
  page: 1,
  steps: [
    { id: s, tool: "search_orders", input: { status: "open" }, out: ids },
    { tool: "cancel_order", input: { orderId: ids[0].id } }
  ]
}
JSON5
```

Scope deliberately minimal: fixed sequential order, JSON-path-ish variable
substitution between steps, no branching, no loops. Agents can already compose
between CLI invocations; the value of step mode is one round trip and one
lifecycle ([ADR-0005]: CLI disconnect cancels its call).

### Scripted expression mode (`--code`) (phase 2, conditional)

Only if step mode demonstrably falls short. Local restricted DSL where each
origin identifier resolves to a Proxy object whose method calls compile to
typed `execute_webmcp_tool` RPCs:

```bash
mcpx @webmcp.exec '{ page: 1, code: "let x = await a_com.tool({name: \"foo\"}); x" }'
```

Guardrails, all mandatory before this ships:

- Explicit `await`; tool calls never implicitly block.
- Interpreter runs locally in an isolated evaluator; whitelisted syntax only,
  no IO, no network, loop cap, wall-clock timeout.
- The identifier→origin binding comes from a prior `@webmcp.info` result
  passed in the same input, so names are resolved against fresh observations,
  not cached guesses.

Phase 2 stays unstarted until phase 1 sees real use; this proposal does not
gate on it.

## Alternatives considered

| Alternative                                | Rejected because                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| Ship only raw chrome-devtools tools        | Leaves Gap-A aggregation to every agent, every time                      |
| Custom MCP server speaking CDP directly    | Duplicates upstream flag/feature handling for zero added capability      |
| Persistent tools directory backed by cache | Violates ADR-0003 separation by dressing observed history as declaration |
| `Runtime.evaluate`-backed code mode        | Works for any page and therefore bypasses WebMCP entirely; wrong layer   |

## Risks

- **Upstream API churn**: WebMCP renamed its surface once already
  (`navigator.modelContext` → `document.modelContext`). Registration-time
  capability check catches this class early; error text should name the
  suspected drift.
- **Origin-trial sunset**: behavior could change or vanish with Chrome
  releases. The bridge adds no durable state, so worst case is command-level
  breakage, discoverable from `@schema` + one failing call.
- **Flag-spelling drift** in chrome-devtools-mcp. Mitigation: assert on the
  documented spelling at install time, link upstream docs from the skill text.

## Open questions

1. Should `@webmcp.info` accept an origin filter argument before phase 1 ships?
2. Does staleness-marked observed history belong behind a separate opt-in verb
   (`@webmcp.history`) rather than enriching `info` output?

## References

- Explainer: <https://github.com/webmachinelearning/webmcp>
- Chrome docs: <https://developer.chrome.com/docs/ai/webmcp>
- Upstream bridge: <https://github.com/ChromeDevTools/chrome-devtools-mcp>
  (`docs/tool-reference.md` § WebMCP)

[ADR-0002]: ../adr/0002-runtime-is-the-sole-declared-registry-writer.md
[ADR-0003]: ../adr/0003-separate-declared-and-observed-state.md
[ADR-0005]: ../adr/0005-cli-disconnect-cancels-its-call.md
[ADR-0006]: ../adr/0006-each-call-owns-its-lifecycle.md
