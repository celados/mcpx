---
type: Decision
title: mcpxd Is the User-Local MCP Runtime
status: accepted
---

# mcpxd Is the User-Local MCP Runtime

MCPX treats `mcpxd` as the single user-local authority for credential lifecycle, active MCP sessions, and tool-call coordination; the CLI is a stateless adapter. This supersedes the V1/V2 split in which the CLI owned authentication and registry-derived runtime state while the daemon owned only pooled connections, because that split permits competing control decisions across concurrent CLI processes.
