---
type: Review
title: Review of WebMCP Bridge proposal v0.1
resource: ./webmcp-bridge.md
verdict: request-changes # approve | request-changes
version: 0.1
generated: { by: codex/gpt-5.6-sol, at: 2026-08-27T03:42:41Z }
---

# Review of WebMCP Bridge proposal v0.1

## Verdict

Request changes. The live `@webmcp.info` path respects the declared/observed
boundary, but the execution target is not bound strongly enough to prevent a
same-tab navigation from turning a selected tool into a different tool call.
The proposal also assumes upstream wire shapes and lifecycle behavior that the
current primitives do not provide without additional normalization and runtime
work.

| Severity | Count |
| --- | ---: |
| blocker | 1 |
| major | 6 |
| minor | 3 |

## Blocker

### B1. `pageId` and origin do not bind execution to the discovered document

**Severity:** blocker

**Evidence:** The proposal says navigation produces a stale-page failure
(`webmcp-bridge.md:136-140`) and says a prior directory passed back in the input
makes origin identifiers resolve against “fresh observations”
(`webmcp-bridge.md:180-182`). Current chrome-devtools-mcp instead assigns an ID
to a Puppeteer `Page`; ordinary navigation keeps that `Page` and ID. Its
`execute_webmcp_tool` implementation then searches the *current* page's tools by
name. A tab can therefore navigate after discovery and expose a same-named tool
that executes successfully rather than producing a stale error. See the pinned
upstream [`McpContext.ts`](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/2dc104ce1bec57f17763cb7d72b33e03057a79bc/src/McpContext.ts)
and [`webmcp.ts`](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/2dc104ce1bec57f17763cb7d72b33e03057a79bc/src/tools/webmcp.ts).
Origin is weaker still: several pages can share one origin, and the current
upstream structured tool entry omits the tool owner's origin. Passing an old
`@webmcp.info` result in the same command input does not refresh it.

**Suggested change:** Replace the stale-navigation claim with the actual
boundary: `pageId` detects closed/reconnected pages, not document replacement.
Require execution input to carry the expected page URL/page origin and a tool
schema fingerprint returned by `info`; immediately re-read the page and tool
before execution and fail closed on any mismatch or ambiguity. State explicitly
that the available primitives provide no atomic discovery-and-execute or
document nonce, so a residual TOCTOU window remains. Remove phase 2's
origin-proxy binding until it can identify one page and validate the same
document-level expectations.

## Major findings

### M1. The registration example cannot provide the structured inputs the design consumes

**Severity:** major

**Evidence:** The example enables only
`--categoryExperimentalWebmcp=true` (`webmcp-bridge.md:67-75`) while the
pseudocode consumes structured page and tool objects (`webmcp-bridge.md:94-110`).
In current chrome-devtools-mcp,
`experimentalStructuredContent` defaults to `false`, and `ToolHandler` omits
`structuredContent` unless it is enabled. Enabling the WebMCP tool category also
does not enable WebMCP in a Chrome instance spawned by the server; the upstream
option requires Chrome 150+ with `WebMCP` enabled and exposes `--chrome-arg` for
passing the feature flag. See pinned upstream
[`mcp-options.ts`](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/2dc104ce1bec57f17763cb7d72b33e03057a79bc/src/config/mcp-options.ts)
and [`ToolHandler.ts`](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/2dc104ce1bec57f17763cb7d72b33e03057a79bc/src/ToolHandler.ts).
The asserted registration/install-time drift check
(`webmcp-bridge.md:84-85,198-206`) has no defined hook in the generic `@add`
flow.

**Suggested change:** Make structured output and Chrome feature enablement
mandatory prerequisites in the example, including
`--experimentalStructuredContent=true` and, for a spawned browser,
`--chrome-arg=--enable-features=WebMCP`. Define a command-time capability
preflight that requires `list_pages`, `list_webmcp_tools`, and
`execute_webmcp_tool`; remove claims about checking the spelling at
registration/install time unless the proposal adds that concrete mechanism.

### M2. The “typed” adapter does not match the upstream wire contract

**Severity:** major

**Evidence:** The proposal models `list_pages()` as returning
`{pageId, url, title}` and passes an input object directly to execution
(`webmcp-bridge.md:95,132-135`). Current upstream structured pages use `id`, not
`pageId`; `execute_webmcp_tool.input` is an optional **JSON-stringified string**;
and execution returns a text JSON envelope containing `status`, `output`, and
`errorText`. These shapes are visible in the pinned upstream
[`tool-reference.md`](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/2dc104ce1bec57f17763cb7d72b33e03057a79bc/docs/tool-reference.md),
[`McpResponse.ts`](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/2dc104ce1bec57f17763cb7d72b33e03057a79bc/src/McpResponse.ts),
and [`webmcp.ts`](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/2dc104ce1bec57f17763cb7d72b33e03057a79bc/src/tools/webmcp.ts).

**Suggested change:** Add an explicit normalization contract: read
`structuredContent.pages[].id`, expose it as the bridge's `pageId`, JSON-encode
the input object exactly once, parse and validate the upstream execution
envelope, and return the WebMCP `output` as the bridge result. Treat absent or
malformed structured content as upstream drift, not as an empty directory.

### M3. WebMCP semantic failure can still look like command success

**Severity:** major

**Evidence:** The proposal promises “never silent empty results” and discusses
only stale-page failures (`webmcp-bridge.md:47-48,136-140`). Current upstream
`execute_webmcp_tool` does not throw merely because the WebMCP execution result
contains a non-success `status` or `errorText`; it serializes those fields into
an otherwise successful MCP tool response. MCPX raises a tool error only when
the MCP result sets `isError: true` (`src/output.ts:41-58`). A naïve thin
composition therefore exits successfully with a semantic failure payload.

**Suggested change:** Specify one error normalization table. Upstream MCP
`isError`, malformed envelopes, non-success WebMCP status, and non-empty
`errorText` must all produce a non-zero `@webmcp.exec` error with a stable code.
For a missing page, the bridge must add the requested `pageId` and recovery hint
itself; the upstream error is only “No page found.” Preserve a successful tool's
`output` even when it is empty instead of using truthiness as success.

### M4. `@webmcp.info` has no result shape for partial observation failure

**Severity:** major

**Evidence:** The proposal says an observed empty list must differ from “we did
not look” and that one failed page degrades only its own entry
(`webmcp-bridge.md:120-125`), but its only page shape contains `tools`
(`webmcp-bridge.md:101-111`). It defines neither an error member nor command
behavior when `list_pages` fails, a page disappears during fan-out, the WebMCP
category is absent, or a list response is malformed. The claimed distinction is
therefore not representable.

**Suggested change:** Define a discriminated page result, for example
`{ status: "ok", tools: [] }` versus
`{ status: "error", error: { code, message, recovery } }`. A root
`list_pages`/capability failure must fail the command; a per-page race may be a
partial report but must retain the page and its explicit error. Add one
`observedAt` timestamp for the invocation and do not substitute `tools: []` on
any failure path.

### M5. Phase 1 is neither valid JSON5 nor one lifecycle on the current seam

**Severity:** major

**Evidence:** The example contains unquoted identifier values and an expression
inside JSON5 (`id: s`, `out: ids`, `ids[0].id`; `webmcp-bridge.md:148-157`), so
the documented input does not parse. The proposal then calls the batch “one
lifecycle” (`webmcp-bridge.md:160-163`). Today each tool handler submits one
`op: 'call'` through `requestRuntime` (`src/router.ts:277-304`); each request
opens its own runtime socket (`src/runtime-client.ts:11-30`), and the runtime
creates one `RuntimeCall` per `call` intent (`src/runtime.ts:51-58`,
`src/runtime-protocol.ts:62-71`). A CLI-side loop is multiple Calls, so ADR-0005
and ADR-0006 do not establish the claimed compound lifecycle.

**Suggested change:** Give references a valid declarative JSON representation,
such as `{ id: "s", ... }` and
`{ orderId: { $ref: "$.steps.s.output[0].id" } }`. Then state where the
compound operation lives. If “one lifecycle” remains a requirement, specify a
single runtime intent owned by one `Call`; otherwise call it adapter-side
orchestration and document that it owns several child Calls. In either case,
define stop-on-first-error, completed-step reporting, disconnect behavior, and
the absence of rollback for already-completed external side effects.

### M6. The proposal claims a Gap B mitigation that it never defines

**Severity:** major

**Evidence:** The proposal says it provides an “explicitly staleness-marked
mitigation” (`webmcp-bridge.md:38-39`), but live `info` writes nothing
(`webmcp-bridge.md:115-117`) and history remains an open question
(`webmcp-bridge.md:208-212`). No historical schema, timestamp, retention,
storage class, or verb exists. ADR-0003 does not ban persisted observed state;
it requires declarations, rebuildable schema knowledge, durable operational
state, and active state to remain separate
(`docs/adr/0003-separate-declared-and-observed-state.md:9`, `CONTEXT.md:45-55`).

**Suggested change:** For v0.1, remove the Gap B mitigation claim and say there
is no historical surface. If history is retained in scope, define it as a
separate opt-in observed-state contract with `observedAt`, browser/session
identity, retention, and an explicit “not current” marker, and name its state
class without writing it into the Declared Registry. Update the alternatives
table to reject presenting cache as declaration, not persistence itself.

## Minor findings

### m1. The bridge silently reserves one user-chosen server name

**Severity:** minor

**Evidence:** The implementation hard-codes `chrome-devtools.*`
(`webmcp-bridge.md:94-97`), while server names are user declarations and raw
commands route through `<server>.<tool>` (`README.md:69-75`). Nothing says the
registration must use the exact name `chrome-devtools` or what happens if two
registered servers expose the required capabilities.

**Suggested change:** Either declare `chrome-devtools` a required exact binding
for this bridge, or add an explicit `server` selector with that default and fail
on a missing or ambiguous capability match.

### m2. `domain` grouping collapses origins it cannot represent

**Severity:** minor

**Evidence:** The algorithm groups `origin(url)` but renders `domain: a.com`
(`webmcp-bridge.md:94-105`). An origin includes scheme and port; opaque URLs
such as `about:blank` and `data:` have no normal origin and commonly stringify
as `null`, which would group unrelated pages together.

**Suggested change:** Emit `pageOrigin` as a full nullable origin, keep the URL
on every page, and place opaque-origin pages in separate page-scoped entries.
Do not call top-level page origin the WebMCP tool owner's origin unless upstream
starts returning that provenance.

### m3. The upstream-owned aggregation alternative is missing

**Severity:** minor

**Evidence:** The alternatives table considers raw tools, a custom CDP server,
persistence, and page evaluation (`webmcp-bridge.md:187-194`), but not adding an
aggregate structured tool to chrome-devtools-mcp, which already owns page IDs,
page lifecycle, and the per-page WebMCP adapters.

**Suggested change:** Add one row evaluating an upstream aggregate endpoint. If
it is rejected, state why MCPX should own the N-call fan-out and the coupling to
chrome-devtools-mcp's experimental output shapes.

## Sections that survived attack

- The live `@webmcp.info` no-write rule at `webmcp-bridge.md:113-119` correctly
  respects ADR-0002 and ADR-0003.
- `@webmcp.*` as an mcpx-owned composition surface, with raw tools left at
  `<server>.<tool>`, matches `README.md:14-17,69-75,135-150`.
- Rejecting `Runtime.evaluate` and keeping arbitrary in-page evaluation out of
  the bridge is consistent with the stated layer boundary.
