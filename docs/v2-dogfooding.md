# mcpxd V2 Dogfooding

This document describes the local notification fixture used to verify V2 daemon behavior through
the same CLI path agents use.

## Register the Fixture

From the repo root:

```sh
bun src/main.ts @add \
  --name notification-fixture \
  --transport stdio \
  --command bun \
  --arg tests/fixtures/notification-mcp-server.mjs
```

Expected output:

- `status: ready`
- `transport: stdio`
- `tools: 5`

## Tool Checks

`progress-stream` emits `notifications/progress` during a call.

```sh
bun src/main.ts notification-fixture progress-stream --count 4 --raw
```

Expected:

- `result.structuredContent.tool` is `progress-stream`.
- `notifications` contains the first and last progress entries.
- The last progress entry has `aggregatedCount: 2`.

`notify-tools-changed` emits `notifications/tools/list_changed` during a call.

```sh
bun src/main.ts notification-fixture notify-tools-changed --raw
```

Expected:

- `notifications` includes `notifications/tools/list_changed`.
- CLI refreshes and writes the registered tool schema back to `servers.json`.

`verbatim-notify` emits an unknown notification method.

```sh
bun src/main.ts notification-fixture verbatim-notify --raw
```

Expected:

- `notifications` includes `notifications/custom/event` verbatim.

`flood-notify` emits enough notifications to exceed the daemon buffer cap.

```sh
bun src/main.ts notification-fixture flood-notify --raw
```

Expected:

- The final notification is `$truncated`.
- `$truncated.params.droppedCount` and `$truncated.params.droppedBytes` are non-zero.

`idle-tools-changed` emits `notifications/tools/list_changed` after the current call has completed.

```sh
bun src/main.ts notification-fixture idle-tools-changed --raw
sleep 0.1
bun src/main.ts notification-fixture progress-stream --count 0 --raw
```

Expected:

- The second call causes CLI schema write-back because the daemon retained the idle
  `tools/list_changed` as `pendingToolsChanged`.
- `toolsChanged` is a control signal for CLI write-back, not a user-facing output field.

## Daemon Status

```sh
bun src/main.ts @daemon status --raw
```

Expected for this fixture:

- one `stdio` server entry with `labels: ["notification-fixture"]`
- `activeCalls: 0`
- `queuedCalls: 0`
- `evictCount: 0`
- `hasRetainedSessionId: false`

Raw notification payloads and session ids are intentionally not exposed through daemon status.
