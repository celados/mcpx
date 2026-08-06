---
type: Reference
title: Issue Tracker
description: GitHub issue workflow used by engineering skills in celados/mcpx.
---

# Issue Tracker

Issues and build specifications live in `celados/mcpx` GitHub Issues. Use `gh` from this repository so it infers the remote.

## Operations

- Create, read, comment, label, and close issues with `gh issue`.
- When a skill says “publish to the issue tracker,” create a GitHub issue.
- When a skill says “fetch the relevant ticket,” read the issue body, comments, and labels.
- Pull requests are not a triage request surface.
- Resolve a bare issue or PR number before operating on it.

## Dependencies

Use GitHub native sub-issues and issue dependencies.

- A dependency points from the blocked issue to the blocker.
- Use the blocker’s numeric database ID, not its issue number or node ID.
- Fall back to a `Blocked by: #...` line only when native dependencies are unavailable.
- A ticket is ready only when every blocker is closed.
