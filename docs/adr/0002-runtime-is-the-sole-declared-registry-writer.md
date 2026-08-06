---
type: Decision
title: The MCP Runtime Is the Sole Declared Registry Writer
status: accepted
---

# The MCP Runtime Is the Sole Declared Registry Writer

All command-driven changes to the Declared Registry go through the MCP Runtime, which is its sole writer. The persisted registry remains inspectable and backup-friendly but is not a supported direct-edit interface; configuration-as-code should use an explicit apply or import operation so external intent cannot race runtime writes.
