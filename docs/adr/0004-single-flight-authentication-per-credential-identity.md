---
type: Decision
title: Single-Flight Authentication per Credential Identity
status: accepted
---

# Single-Flight Authentication per Credential Identity

The MCP Runtime permits at most one refresh or interactive Authentication Flow for a Credential Identity. Concurrent callers share its result; disconnecting a caller removes only that waiter, while the final waiter leaving cancels the flow, so concurrent commands cannot rotate the same grant independently or open duplicate authorization pages.
