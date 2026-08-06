---
type: Context
title: MCPX Domain Language
description: Canonical vocabulary for the user-local MCP runtime and its command interface.
---

# MCPX

MCPX gives local commands one consistent authority for discovering, authenticating, and invoking registered MCP servers.

## Language

**MCP Runtime**:
The single user-local authority for credential lifecycle, active MCP sessions, and tool-call coordination.
_Avoid_: Daemon, session manager, connection pool when referring to the whole authority

**CLI Adapter**:
A short-lived command interface that submits intent to the MCP Runtime and renders its response.
_Avoid_: Client control plane, auth owner

**Declared Registry**:
The persistent set of MCP server declarations chosen by the user, excluding credentials and observed runtime state.
_Avoid_: Runtime registry, session config, schema cache

**Credential Store**:
The durable, sensitive authorization material that lets MCPX act for the user without embedding secrets in server declarations.
_Avoid_: Auth config, token registry

**Credential Identity**:
The stable authorization identity shared by every server declaration and call that must use the same grant.
_Avoid_: Server key, access token, session ID

**Authentication Flow**:
One explicitly requested, shared attempt to make a Credential Identity usable; ordinary Calls report that authentication is required instead of starting the flow.
_Avoid_: Per-command login, token retry

**Caller Input**:
A request/response on the active Runtime connection for secret or interactive data. The CLI Adapter renders the prompt, while the MCP Runtime retains Authentication Flow ownership.
_Avoid_: Daemon stdin, CLI-owned OAuth flow

**Call**:
One caller-owned request that moves from accepted through queued or active work to exactly one terminal outcome.
_Avoid_: Detached job, background task

**Schema Cache**:
Rebuildable knowledge MCPX has observed about server tools and their schemas.
_Avoid_: Declared tools, registry schema

**Active State**:
Ephemeral facts about work currently coordinated by the MCP Runtime.
_Avoid_: Persistent config, runtime registry

**Durable Operational State**:
Rebuildable or continuity-preserving coordination data that survives MCP Runtime restarts but is neither user intent nor authorization material.
_Avoid_: Declared Registry, Credential Store
