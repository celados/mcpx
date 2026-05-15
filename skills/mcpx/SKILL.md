---
name: mcpx
description: Use when the user needs to discover or call already-configured remote MCP servers through the mcpx CLI, including generating project-local MCP routing skills.
---

# mcpx

`mcpx` turns registered remote MCP servers into an agent-friendly command surface.
Use it when a task needs MCP-backed services such as PostHog, Sentry, Cloudflare,
or another server registered in the user's global mcpx registry.

## Execution Rules

- Run `mcpx` directly.
- Start with the server inventory instead of dumping every registered schema.
- Call MCP tools as `mcpx <server> <tool> --input <json>`.
- Pass all tool arguments through `--input`; do not invent flags for remote MCP tool fields.
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

Default output is optimized for agents. Use `--raw` only when the exact MCP
server text must be preserved.

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

## Feedback

If mcpx behaves unexpectedly, capture the exact command, schema selector, input,
and structured error, then file an issue:

```bash
gh issue create -R AIGC-Hackers/mcpx --title "bug: <summary>" --body "<repro steps and error output>"
```
