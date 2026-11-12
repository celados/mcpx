# mcpx

Acts as the user's global MCP registry (`~/.agents/mcpx/servers.json`): every registered server (PostHog, Sentry, Cloudflare, ...) is mounted as a command group `<server>`, and each MCP tool is `<server>.<tool>`. Preflight: bare `mcpx` lists the registered servers.

The surface depends on the registry, so read only the slice you need: `mcpx @schema .<server>`, a tool with `mcpx @schema .<server>.<tool>`, a shortlist with `mcpx @schema '.<server>.{a,b,c}'`. Bare `mcpx @schema` dumps every server and burns context; use it only when the user asks for the whole surface. Deeper material: `mcpx @skill references/<file>`.

## Everywhere

- Registration and OAuth are human-owned. If a needed server is missing or unauthenticated, stop and ask the user. Don't hand-edit `servers.json` or token caches unless they ask for registry surgery.
- Default output is agent-optimized (YAML for structured content, text passed through, media saved as `file saved <path>`). Pass `--context "{ output: 'raw' }"` only when exact server output matters.

## Approaching a server — `.<server>`

1. Pick the likely server from the request and run `mcpx @schema .<server>`.
2. Follow the schema's status line: if it says fully shown, call the tool; if only an outline, narrow to the candidate tools with `.<server>.{a,b}`.

## Calling a tool — `.<server>.<tool>`

- Call as `mcpx <server>.<tool> "<object>"`. The object is the complete tool input: one quoted token, or the whole object as YAML/JSON5 from `@file` or stdin (`-`).
- Put multi-line text in a quoted heredoc with `|` block scalars. Field values are literal: no field takes `-` or `@path`. Quote scalars YAML would retype (`'1.10'`, `'012'`, `'true'`). A file or stdin starting with `{` is read as JSON5.
- Tool results may include `$notifications` (progress, server events). Ignore them unless the task depends on them; format and special cases: `mcpx @skill references/notifications.md`.

## Registering servers — `.{"@add","@login","@remove"}` (quote the `@`)

Only when the user asks. After `@add`, HTTP and stdio servers behave identically. Register a bearer token as `env:NAME` so the secret stays out of the registry and argv. `@login "{ name: '<server>' }"` needs a TTY; otherwise ask the user to run it.

## Project-local skills — `."@skill-install"`

When the user wants a project to expose only an approved set of servers, `mcpx @skill-install "{ servers: 'posthog,sentry' }"` writes `.agents/skills/mcpx/` (router plus install and server-recovery references). `{ show: 'sentry' }` prints a one-server skill to stdout without writing files. It does not replace `@add`.

## Daemon — `."@daemon"`

`mcpxd` keeps sessions warm and is normally invisible. For stuck sessions, surprising eviction or schema drift read `mcpx @skill references/daemon.md` before filing an issue.

## Feedback

Capture the exact command, selector, input and structured error, then `gh issue create -R celados/mcpx --title "bug: <summary>" --body "<repro>"`.
