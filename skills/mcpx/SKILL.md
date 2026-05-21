---
name: mcpx
description: Use when the user needs to discover or call already-configured MCP servers through the mcpx CLI, including generating project-local MCP routing skills.
---

# mcpx

`mcpx` turns registered MCP servers into an agent-friendly command surface.
Use it when a task needs MCP-backed services such as PostHog, Sentry, Cloudflare,
or another server registered in the user's global mcpx registry.

## Execution Rules

- Run `mcpx` directly.
- Start with the server inventory instead of dumping every registered schema.
- Call MCP tools as `mcpx <server> <tool> --input <json>`.
- Pass all tool arguments through `--input`; do not invent flags for MCP tool fields.
- Use focused schema selectors before calling tools on large MCP surfaces.
- Do not hand-edit `~/.agents/mcpx/servers.json` or token cache files unless the user explicitly asks for registry surgery.
- Treat MCP server registration and OAuth setup as human-owned configuration. If a required server is missing or unauthenticated, stop and ask the user to configure it.

## First Move: Discover The Surface

At the start of an MCP task, run bare `mcpx` to list configured servers:

```bash
mcpx
```

Choose the likely server from the user's request, then inspect only that server's
schema:

```bash
mcpx --schema=.sentry
mcpx --schema=.posthog
```

After that, narrow to the specific tool or a short candidate list:

```bash
mcpx --schema=.posthog.projects-get
mcpx --schema='.posthog.{projects-get,alerts-list,alert-create}'
```

Avoid `mcpx --schema` unless the user explicitly asks for the complete command
surface. On a real registry it may expand every server schema and waste the
agent context.

## Call Tools

Use inline JSON/JSON5 for tiny inputs:

```bash
mcpx posthog projects-get --input '{}'
mcpx sentry search-issues --input '{"query":"is:unresolved"}'
```

For non-trivial payloads, prefer `@file` or heredoc input:

```bash
mcpx <server> <tool> --input @payload.json

mcpx <server> <tool> --input @- <<'JSON'
{
  "query": "is:unresolved"
}
JSON
```

Default output is optimized for agents (TOON encoding for structured content,
direct text passthrough, media saved as `file saved <path>`). Use `--raw` to
disable that optimization. When a tool emits notifications, `--raw` output may
also include a JSON envelope — see Notifications below.

## Server Transports

mcpx supports two MCP transports, both configured through `mcpx @add`:

- **HTTP** — default. Remote MCP services like PostHog or Sentry.
- **Stdio** — local processes started by mcpx, for example
  `mcpx @add --name fs --transport stdio --command bunx --arg -y --arg @modelcontextprotocol/server-filesystem --arg /tmp/fs-sandbox`.

After registration both behave identically from the agent's view: same schema
discovery, same `mcpx <server> <tool> --input ...` call pattern, same output
shape. You do not need to differentiate when calling tools.

## Notifications

Most tools emit no notifications and this section never applies.

When an MCP server emits events during a call (progress reporting, server-side
state changes, custom events), mcpx merges them into default structured output
under an injected `@notifications` field:

```
count: 1
@notifications[1]{method,params}:
  notifications/progress,{progressToken:"...",progress:3,total:4,message:"step 3"}
```

For non-JSON text, binary, or mixed content, mcpx falls back to the trailing
sentinel line:

```
<tool result lines>
@notification: [{"method":"notifications/progress","params":{...}}]
```

Notifications are objects with these fields:

- `method` — MCP notification method name
- `params` — method-specific payload (shape depends on `method`)
- `aggregatedCount` — only on the **last** `notifications/progress` entry per
  progress token; indicates that N intermediate progress entries were collapsed
  to keep output bounded. The first and last entries are preserved verbatim.

Notification methods you may encounter:

| method                                | meaning                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notifications/progress`              | Progress for a long-running tool. Carries `{ progressToken, progress, total?, message? }`.                                                               |
| `notifications/tools/list_changed`    | Server's tool schema changed. mcpx automatically refreshes the registry; you do not need to react.                                                       |
| `$oversize`                           | Synthetic raw-mode marker. Means notifications were saved to a temp JSON file. Default output renders this as `notifications oversize, saved to <path>`. |
| other (e.g. `notifications/custom/*`) | Passed through verbatim. Server-specific.                                                                                                                |

In `--raw` mode with a structured result and non-empty notifications, the
trailing sentinel line is replaced by a JSON envelope on stdout:

```json
{ "result": <tool-result>, "notifications": [ ... ] }
```

Text results keep the trailing `@notification:` line even under `--raw`,
because text content is not JSON and wrapping it would break consumers.

Practical guidance:

- If your task does not depend on progress or server events, ignore notifications.
- Check `@notifications`, the sentinel line, or the raw envelope only when present.
- Do not assume notifications appear; the common case is no `@notification:` at all.

## Project-Local Skills

When the user has already configured the relevant global MCP servers and wants a
project to expose only that approved set to agents, generate a project-local mcpx
skill:

```bash
mcpx @skill --servers posthog,sentry
```

This writes:

```text
.agents/skills/mcpx/SKILL.md
```

Use the generated project skill as the project-specific router. It should name
servers the user has already made available; do not use this flow to register or
authenticate new MCP servers.

## References

mcpx maintains a background daemon (`mcpxd`) for session reuse and notification
buffering. You normally do not need to interact with it. If a tool call behaves
unexpectedly (stuck session, surprising eviction, schema drift), see
[references/daemon.md](references/daemon.md) before filing an issue.

## Feedback

If mcpx behaves unexpectedly, capture the exact command, schema selector, input,
and structured error, then file an issue:

```bash
gh issue create -R AIGC-Hackers/mcpx --title "bug: <summary>" --body "<repro steps and error output>"
```
