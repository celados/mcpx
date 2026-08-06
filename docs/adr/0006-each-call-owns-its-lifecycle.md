---
type: Decision
title: Each Call Owns Its Lifecycle
status: accepted
---

# Each Call Owns Its Lifecycle

Each Call is the sole authority for its queued, active, and terminal transitions, caller-disconnect cancellation, and lifecycle cleanup. A shared session decides when queued work may proceed but cannot transition or cancel the Call itself, because splitting lifecycle ownership between the CLI connection and session queue permits activation after disconnect and cancellation after completion.
