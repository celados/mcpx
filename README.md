# mcpx

mcpx is a command line tool that turns registered MCP servers into an
agent-friendly command surface.

It keeps MCP server registrations in a global user registry, discovers tool
schemas, handles OAuth where possible, and exposes each MCP server as a root
command:

```bash
mcpx posthog.projects-get
mcpx sentry.search-issues '{"query":"is:unresolved"}'
```

mcpx is designed for agents. The command surface is intentionally schema-first,
stable, and explicit: commands use dotted paths and receive one structured input
token, while mcpx's own control commands live under the `@` namespace.

## Requirements

- Bun
- macOS, Linux, or any environment that can run Bun executables

## Install

Install the latest release:

```bash
curl -fsSL https://raw.githubusercontent.com/celados/mcpx/main/install.sh | bash
```

By default, the installer downloads the executable JS bundle from GitHub Releases
and installs it to `~/.local/bin/mcpx`.

Set `MCPX_INSTALL_DIR` to choose another install directory.

## Add MCP Servers

Register MCP servers globally:

```bash
mcpx @add "{ name: 'posthog', url: 'https://mcp.posthog.com/mcp' }"
mcpx @add "{ name: 'sentry', url: 'https://mcp.sentry.dev/mcp' }"
mcpx @add "{ name: 'cf-docs', url: 'https://docs.mcp.cloudflare.com/mcp' }"
mcpx @add "{ name: 'cf-bindings', url: 'https://bindings.mcp.cloudflare.com/mcp' }"
mcpx @add "{ name: 'cf-observability', url: 'https://observability.mcp.cloudflare.com/mcp' }"
mcpx @add "{ name: 'browser', url: 'http://127.0.0.1:9000/mcp' }"
```

> [browser-os](https://www.browseros.com/) is an agent-native browser built on
> Chrome. It exposes a local MCP server that lets agents control the browser
> directly — navigating pages, extracting content, and interacting with web UIs.

mcpx stores server configuration in:

```text
~/.agents/mcpx/servers.json
```

OAuth tokens and client secrets are stored separately in the global token cache:

```text
~/.agents/mcpx/tokens.json
```

Project directories do not need MCP config files. A project should decide which
global servers are relevant by using schema selectors or a generated skill.

## Call Tools

Call tools through the server command:

```bash
mcpx <server>.<tool> '<json-or-json5>'
```

Examples:

```bash
mcpx posthog.projects-get '{}'
mcpx sentry.whoami '{}'
```

For complex payloads, use stdin to keep the input readable:

```bash
mcpx cf-graphql.graphql_query - <<'JSON'
{
  "query": "query GetWorkerAnalytics($accountTag: String!, $scriptName: String!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $accountTag}) { workersInvocationsAdaptive(limit: 1000, filter: {scriptName: $scriptName, datetime_geq: $since, datetime_leq: $until}, orderBy: [datetimeHour_ASC]) { dimensions { datetimeHour scriptName status } sum { requests subrequests errors duration } quantiles { cpuTimeP50 cpuTimeP99 } } } } }",
  "operationName": "GetWorkerAnalytics",
  "variables": {
    "accountTag": "abc123def456",
    "scriptName": "my-worker",
    "since": "2026-04-20T00:00:00Z",
    "until": "2026-04-27T00:00:00Z"
  }
}
JSON
```

The command accepts exactly one input object. Pass it inline, as `@file`, or
through `-` stdin.

## Discover Schemas

Print the command schema for agents:

```bash
mcpx @schema
```

Focus on one server:

```bash
mcpx @schema .posthog
```

Focus on a set of servers:

```bash
mcpx @schema '.{posthog,sentry}'
```

Focus on an internal mcpx command:

```bash
mcpx @schema '.["@add"]'
```

mcpx caches discovered tool schemas in the global registry. Cached schemas older
than one day are refreshed opportunistically in a single background worker when
mcpx starts, so normal commands do not block on schema discovery. Servers that
have not discovered any tools yet are still retried synchronously during startup.

## Control Commands

mcpx control commands use the `@` namespace so they do not collide with server
names:

```bash
mcpx @add "{ name: '<server>', url: '<mcp-url>' }"
mcpx @add "{ name: '<server>', url: '<mcp-url>', bearer: 'env:<TOKEN_ENV>' }"
mcpx @add "{ name: '<server>', transport: 'stdio', command: '<command>', args: ['<arg>'] }"
mcpx @remove "{ name: '<server>' }"
mcpx @refresh
mcpx @daemon.status
mcpx @daemon.stop
mcpx @daemon.server
mcpx @skill
mcpx @skill-install
```

Server names cannot start with `@`.

HTTP is the default transport. Pass bearer credentials as a string or array.
`env:NAME` reads a token from an environment variable at runtime; literal values
are accepted but are stored in the registry:

```bash
mcpx @add "{ name: 'posthog', url: 'https://mcp.posthog.com/mcp', bearer: 'env:POSTHOG_TOKEN' }"
mcpx @add "{ name: 'posthog', url: 'https://mcp.posthog.com/mcp', bearer: ['env:POSTHOG_TOKEN_A', 'env:POSTHOG_TOKEN_B'] }"
```

Multiple bearer credentials use round-robin selection by default. Stdio servers
are local process registrations with structured `args` and `env`:

```bash
mcpx @add '{
  "name": "open-design",
  "transport": "stdio",
  "command": "node",
  "args": ["/path/to/open-design/apps/daemon/dist/cli.js", "mcp"],
  "env": { "OPEN_DESIGN_TOKEN": "..." }
}'
```

`@refresh` checks every registered MCP server, repairs OAuth state first,
refreshes cached tool schemas after auth is ready, and reports servers that
still require re-authentication. It may open a browser for interactive OAuth.

Stdio servers are called through `mcpxd`, a user-local daemon that reuses stdio
MCP sessions across CLI invocations. `mcpxd` starts on demand, keeps idle stdio
servers warm, and can be inspected or stopped with `mcpx @daemon.status` and
`mcpx @daemon.stop`. The daemon process is started through the explicit
`mcpx @daemon.server` subcommand. HTTP servers continue to use the direct client path.

## Authentication

Bearer auth is configured explicitly in the `@add` input. Prefer `env:NAME`
references so secrets stay out of the registry. `${NAME}` is also accepted when
passed through the shell literally.
When several bearer credentials are registered, mcpx advances a local
round-robin cursor before each HTTP request.

When `@add` detects OAuth, mcpx tries to complete authentication immediately.
For OAuth servers that support dynamic client registration, mcpx registers a
client automatically.

For OAuth servers that do not support dynamic client registration, such as
Slack, mcpx prompts for a manual `client_id` and `client_secret`. These providers
usually require a preconfigured redirect URL. mcpx uses:

```text
http://127.0.0.1:65245/callback
```

Add and save that exact Redirect URL in the provider app settings before
continuing the prompt.

When an OAuth token is close to expiry, mcpx refreshes it before calling the MCP
tool and then continues the original command.

Tool calls use a 5 minute request timeout by default. Set
`MCPX_TOOL_CALL_TIMEOUT_MS` when a remote MCP server legitimately needs longer.

mcpx buffers MCP subscription notifications and returns them with the next daemon
tool-call result by default. Set `MCPX_NOTIFICATION_MODE=discard` to ignore those
notifications for a command; accepted values are `buffer` and `discard`.

## Output

mcpx optimizes output for humans and agents by default:

- text MCP content is printed directly
- JSON text content is rendered as YAML
- non-text content is saved to a temporary file and printed as `file saved <path>`
- supplemental MCP `structuredContent` is printed as `$structured` only when it
  is not already represented by the primary content

Use argc context to preserve raw server output:

```bash
mcpx posthog.projects-get --context "{ output: 'raw' }"
```

## Project Skills

Generate a project-local skill that tells agents which global MCP servers to use:

```bash
mcpx @skill-install "{ servers: 'posthog,sentry' }"
```

This writes:

```text
.agents/skills/mcpx/SKILL.md
.agents/skills/mcpx/references/install.md
.agents/skills/mcpx/references/servers.md
```

The generated skill instructs agents to discover tools with focused schema
selectors and call MCP tools through mcpx. A Troubleshooting section at the
bottom points collaborators at install and server-setup references so their
agent can recover when `mcpx` is missing or a listed server is not registered.

For temporary agent guidance without writing `.agents/skills`, print a one-server
skill to stdout:

```bash
mcpx @skill-install "{ show: 'slack' }"
```

## Skill

General mcpx skill definition lives at `src/index.md` (served by `mcpx @skill`).

## License

MIT
