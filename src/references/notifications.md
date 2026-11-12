# mcpx notifications

Selector for any server: `mcpx @schema .<server>`. Most tools emit no notifications, so read this only when a result carries `$notifications` or a trailing `$notification:` line.

When an MCP server emits events during a call (progress reporting, server-side
state changes, custom events), mcpx merges them into default structured output
under an injected `$notifications` field:

```yaml
count: 1
$notifications:
  - method: notifications/progress
    params:
      progressToken: '...'
      progress: 3
      total: 4
      message: step 3
```

For non-JSON text, binary, or mixed content, mcpx falls back to the trailing
sentinel line:

```
<tool result lines>
$notification: [{"method":"notifications/progress","params":{...}}]
```

Notifications are objects with these fields:

- `method` — MCP notification method name
- `params` — method-specific payload (shape depends on `method`)
- `aggregatedCount` — only on the **last** `notifications/progress` entry per
  progress token; indicates that N intermediate progress entries were collapsed
  to keep output bounded. The first and last entries are preserved verbatim.

Notification methods you may encounter:

| method                                | meaning                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notifications/progress`              | Progress for a long-running tool. Carries `{ progressToken, progress, total?, message? }`.                                                               |
| `notifications/tools/list_changed`    | Server's tool schema changed. mcpx automatically refreshes the registry; you do not need to react.                                                       |
| `$oversize`                           | Synthetic raw-mode marker. Means notifications were saved to a temp JSON file. Default output renders this as `notifications oversize, saved to <path>`. |
| other (e.g. `notifications/custom/*`) | Passed through verbatim. Server-specific.                                                                                                                |

In raw context with a structured result and non-empty notifications, the
trailing sentinel line is replaced by a JSON envelope on stdout:

```json
{ "result": <tool-result>, "notifications": [ ... ] }
```

Text results keep the trailing `$notification:` line even in raw context,
because text content is not JSON and wrapping it would break consumers.

Practical guidance:

- If your task does not depend on progress or server events, ignore notifications.
- Check `$notifications`, the sentinel line, or the raw envelope only when present.
- Do not assume notifications appear; the common case is no `$notification:` at all.
