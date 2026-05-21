import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode, encode } from "@toon-format/toon";
import type { DaemonOutputEnvelope } from "./daemon-result";
import { unwrapDaemonOutput } from "./daemon-result";
import type { McpNotification } from "./daemon-protocol";

export type McpxContext = {
  output: "toon" | "raw";
};

type McpContent = Record<string, unknown> & {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  blob?: unknown;
  mimeType?: unknown;
  resource?: unknown;
};

type McpToolResult = {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: unknown;
  _meta?: unknown;
};

export async function printOutput(value: unknown, context: McpxContext): Promise<void> {
  const daemonResponse = unwrapDaemonOutput(value);
  if (daemonResponse) {
    await printDaemonOutput(daemonResponse, context);
    return;
  }

  if (isMcpToolResult(value)) {
    const isError = value.isError === true;
    const write = isError ? console.error : console.log;
    if (isError) process.exitCode = 1;

    if (value.structuredContent !== undefined && value.structuredContent !== null) {
      write(formatStructuredContent(value, context.output));
      return;
    }

    for (const line of await formatMcpContent(value.content ?? [], context.output)) {
      write(line);
    }
    return;
  }

  if (context.output === "raw") {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  console.log(encode(value));
}

async function printDaemonOutput(value: DaemonOutputEnvelope, context: McpxContext): Promise<void> {
  const notifications = value.notifications;
  if (context.output === "raw" && isStructuredDaemonResult(value.result)) {
    console.log(JSON.stringify({ result: value.result, notifications }, null, 2));
    return;
  }

  await printOutput(value.result, context);
  for (const line of formatNotifications(notifications)) {
    console.log(line);
  }
}

function formatNotifications(notifications: McpNotification[]): string[] {
  if (notifications.length === 0) return [];
  return [`@notification: ${JSON.stringify(notifications.map(normalizeNotificationForOutput))}`];
}

function normalizeNotificationForOutput(notification: McpNotification): McpNotification {
  const normalized: McpNotification & { aggregatedCount?: number } = {
    method: notification.method,
  };
  const record = notification as McpNotification & { aggregatedCount?: number };
  if ("params" in notification) normalized.params = notification.params;
  if (record.aggregatedCount !== undefined) normalized.aggregatedCount = record.aggregatedCount;
  return normalized;
}

function isStructuredDaemonResult(value: unknown): boolean {
  if (!isMcpToolResult(value)) return true;
  if (value.structuredContent !== undefined && value.structuredContent !== null) return true;
  const content = value.content ?? [];
  return !content.some((item) => item.type === "text" && typeof item.text === "string");
}

export async function formatMcpContent(
  content: McpContent[],
  outputFormat: McpxContext["output"] = "toon",
): Promise<string[]> {
  const output: string[] = [];

  for (const item of content) {
    switch (item.type) {
      case "text":
        if (typeof item.text === "string") output.push(formatTextContent(item.text, outputFormat));
        break;
      case "resource":
        output.push(await formatEmbeddedResource(item.resource, outputFormat));
        break;
      case "resource_link":
        output.push(formatResourceLink(item, outputFormat));
        break;
      default:
        output.push(await saveBinaryContent(item));
    }
  }

  return output;
}

function formatStructuredContent(result: McpToolResult, output: McpxContext["output"]): string {
  const value =
    output === "raw" && result._meta !== undefined
      ? { structuredContent: result.structuredContent, _meta: result._meta }
      : result.structuredContent;

  return output === "raw" ? JSON.stringify(value, null, 2) : encode(value);
}

function formatTextContent(text: string, output: McpxContext["output"]): string {
  if (output === "raw") return text;

  const parsedJson = parseJsonText(text);
  if (parsedJson !== undefined) {
    return encode(parsedJson);
  }

  const parsedToon = parseToonText(text);
  if (parsedToon !== undefined) {
    return text;
  }

  return text;
}

function parseJsonText(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function parseToonText(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.includes(":")) return undefined;
  try {
    return decode(trimmed);
  } catch {
    return undefined;
  }
}

async function saveBinaryContent(content: McpContent): Promise<string> {
  const bytes = contentBytes(content);
  const mimeType = typeof content.mimeType === "string" ? content.mimeType : undefined;
  const hash = createHash("sha256").update(bytes).digest("hex");
  const filePath = path.join(tmpdir(), `mcpx-${hash}${extensionForMimeType(mimeType)}`);
  await fs.writeFile(filePath, bytes);
  return `file saved ${filePath}`;
}

async function formatEmbeddedResource(
  resource: unknown,
  outputFormat: McpxContext["output"],
): Promise<string> {
  if (!isMcpContent(resource)) {
    return formatTextContent(JSON.stringify(resource, null, 2), outputFormat);
  }
  if (typeof resource.text === "string") {
    return formatTextContent(resource.text, outputFormat);
  }
  return saveBinaryContent(resource);
}

function formatResourceLink(content: McpContent, outputFormat: McpxContext["output"]): string {
  const link = omitUndefined({
    type: content.type,
    uri: content.uri,
    name: content.name,
    title: content.title,
    description: content.description,
    mimeType: content.mimeType,
    size: content.size,
  });
  return outputFormat === "raw" ? JSON.stringify(link, null, 2) : encode(link);
}

function contentBytes(content: McpContent): Buffer {
  if (typeof content.data === "string") {
    return Buffer.from(content.data, "base64");
  }
  if (typeof content.blob === "string") {
    return Buffer.from(content.blob, "base64");
  }
  if (typeof content.text === "string") {
    return Buffer.from(content.text, "utf8");
  }
  return Buffer.from(JSON.stringify(content, null, 2), "utf8");
}

function extensionForMimeType(mimeType: string | undefined): string {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/svg+xml":
      return ".svg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
      return ".wav";
    case "audio/ogg":
      return ".ogg";
    case "application/json":
      return ".json";
    case "text/plain":
      return ".txt";
    default:
      return ".bin";
  }
}

function isMcpToolResult(value: unknown): value is McpToolResult {
  if (!value || typeof value !== "object") return false;
  const result = value as McpToolResult;
  return Array.isArray(result.content) || "structuredContent" in result;
}

function isMcpContent(value: unknown): value is McpContent {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
