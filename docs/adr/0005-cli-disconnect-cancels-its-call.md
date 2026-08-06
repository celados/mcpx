---
type: Decision
title: CLI Disconnect Cancels Its Call
status: accepted
---

# CLI Disconnect Cancels Its Call

A normal Call is owned by its originating CLI connection: disconnect removes a queued Call or requests cancellation of an active Call, and the MCP Runtime never writes its result to a dead connection. Cancellation is best-effort and does not promise to undo external side effects; detached Calls require a future explicit interface rather than arising accidentally from disconnects.
