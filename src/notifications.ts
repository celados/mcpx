import type { McpNotification } from "./daemon-protocol";

export const NOTIFICATION_BUFFER_CAP_BYTES = 65_536;
export const NOTIFICATION_BUFFER_CAP_COUNT = 100;

export type NotificationBuffer = {
  add: (notification: McpNotification) => void;
  flush: () => McpNotification[];
  toolsChanged: () => boolean;
};

export function createNotificationBuffer(): NotificationBuffer {
  const notifications: McpNotification[] = [];
  const progressByToken = new Map<string, { index: number; seen: number }>();
  let byteLength = 0;
  let droppedCount = 0;
  let droppedBytes = 0;
  let toolsChanged = false;

  return {
    add(notification) {
      if (notification.method === "notifications/tools/list_changed") toolsChanged = true;

      if (isProgressNotification(notification)) {
        const key = String(notification.params.progressToken);
        const existing = progressByToken.get(key);
        if (existing) {
          existing.seen += 1;
          if (existing.seen === 2) {
            append(notification);
            progressByToken.set(key, { index: notifications.length - 1, seen: existing.seen });
            return;
          }
          notifications[existing.index] = {
            ...notification,
            aggregatedCount: existing.seen - 2,
          };
          return;
        }
        progressByToken.set(key, { index: notifications.length, seen: 1 });
      }

      append(notification);
    },
    flush() {
      if (droppedCount > 0) {
        notifications.push({
          method: "$truncated",
          params: { droppedCount, droppedBytes },
        });
      }
      return notifications;
    },
    toolsChanged() {
      return toolsChanged;
    },
  };

  function append(notification: McpNotification): void {
    const bytes = Buffer.byteLength(JSON.stringify(notification), "utf8");
    if (
      notifications.length >= NOTIFICATION_BUFFER_CAP_COUNT ||
      byteLength + bytes > NOTIFICATION_BUFFER_CAP_BYTES
    ) {
      droppedCount += 1;
      droppedBytes += bytes;
      return;
    }
    notifications.push(notification);
    byteLength += bytes;
  }
}

function isProgressNotification(
  notification: McpNotification,
): notification is Extract<McpNotification, { method: "notifications/progress" }> {
  return (
    notification.method === "notifications/progress" && typeof notification.params === "object"
  );
}
