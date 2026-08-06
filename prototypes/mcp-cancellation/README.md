---
type: Prototype
title: MCP Call Cancellation
description: Throwaway runner for pinned SDK cancellation behavior over local stdio and Streamable HTTP fixtures.
---

# MCP Call Cancellation

This throwaway prototype asks whether one caller-owned `AbortSignal` can cancel
`Client.callTool` promptly without sacrificing a reusable stdio or Streamable
HTTP connection. It drives four server outcomes: respect cancellation, ignore
and reply late, reply as cancellation races, and complete before the caller
aborts.

No fixture performs OAuth or connects beyond loopback and a spawned local stdio
process.

## Run

Interactive state view:

```sh
bun run prototype:cancellation
```

Deterministic evidence capture:

```sh
bun run prototype:cancellation:evidence
```

The evidence command writes `evidence.json` beside this file.

See [`findings.md`](findings.md) for the observed verdict and the proposed MCPX
adapter boundary.
