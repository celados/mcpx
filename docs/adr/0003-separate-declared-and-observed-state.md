---
type: Decision
title: Separate Declared and Observed State
status: accepted
---

# Separate Declared and Observed State

MCPX stores user declarations, authorization material, rebuildable schema knowledge, durable operational state, and active in-memory coordination as distinct classes of state. Derived schema or runtime status must not be written into the Declared Registry, because incidental observations must never contend with or overwrite user intent.
