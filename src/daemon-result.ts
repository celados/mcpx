import type { McpNotification } from "./daemon-protocol";

export type DaemonOutputEnvelope = {
  __mcpxDaemonResponse: true;
  result: unknown;
  notifications: McpNotification[];
  toolsChanged?: boolean;
};

export function daemonOutputEnvelope(value: {
  result: unknown;
  notifications: McpNotification[];
  toolsChanged?: boolean;
}): DaemonOutputEnvelope {
  const envelope: DaemonOutputEnvelope = {
    __mcpxDaemonResponse: true,
    result: value.result,
    notifications: value.notifications,
  };
  if (value.toolsChanged) envelope.toolsChanged = true;
  return envelope;
}

export function unwrapDaemonOutput(value: unknown): DaemonOutputEnvelope | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<DaemonOutputEnvelope>;
  return record.__mcpxDaemonResponse === true ? (record as DaemonOutputEnvelope) : undefined;
}
