import { domainError } from '@celados/argc'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stringify as stringifyYaml } from 'yaml'

import type { McpNotification } from './daemon-protocol'
import type { DaemonOutputEnvelope } from './daemon-result'

import { unwrapDaemonOutput } from './daemon-result'

export type McpxContext = {
	output: 'optimized' | 'raw'
}

type McpContent = Record<string, unknown> & {
	type?: unknown
	text?: unknown
	data?: unknown
	blob?: unknown
	mimeType?: unknown
	resource?: unknown
}

type McpToolResult = {
	content?: McpContent[]
	structuredContent?: unknown
	isError?: unknown
	_meta?: unknown
}

export async function renderOutput(
	value: unknown,
	context: McpxContext,
): Promise<string | undefined> {
	const lines = await formatOutputLines(value, context)
	return lines.length === 0 ? undefined : `${lines.join('\n')}\n`
}

async function formatOutputLines(
	value: unknown,
	context: McpxContext,
): Promise<string[]> {
	const daemonResponse = unwrapDaemonOutput(value)
	if (daemonResponse) {
		return formatDaemonOutput(daemonResponse, context)
	}

	if (isMcpToolResult(value)) {
		const lines = await formatMcpToolResult(value, context)
		if (value.isError === true) {
			throw domainError(
				'MCP_TOOL_ERROR',
				lines.join('\n') || 'The MCP tool returned an error.',
			)
		}
		return lines
	}

	if (context.output === 'raw') {
		return [JSON.stringify(value, null, 2)]
	}

	return [formatYaml(value)]
}

async function formatMcpToolResult(
	value: McpToolResult,
	context: McpxContext,
): Promise<string[]> {
	const content = value.content ?? []
	if (content.length > 0) {
		const lines = await formatMcpContent(content, context.output)
		const structured = formatSupplementalStructuredContent(
			value,
			context.output,
		)
		if (structured) lines.push(structured)
		return lines
	}

	if (hasStructuredContent(value)) {
		return [formatStructuredContent(value, context.output)]
	}
	return []
}

async function formatDaemonOutput(
	value: DaemonOutputEnvelope,
	context: McpxContext,
): Promise<string[]> {
	const notifications = value.notifications.map(normalizeNotificationForOutput)
	if (context.output === 'raw' && isStructuredDaemonResult(value.result)) {
		return [JSON.stringify({ result: value.result, notifications }, null, 2)]
	}

	if (context.output === 'optimized') {
		// Notifications are only merged when the result is already object-shaped;
		// arbitrary text stays untouched so existing text consumers are not wrapped.
		const resultObject = resultAsMergeableObject(value.result)
		if (resultObject) {
			return [formatYaml(mergeNotifications(resultObject, notifications))]
		}
	}

	return [
		...(await formatOutputLines(value.result, context)),
		...formatNotifications(notifications),
	]
}

function formatNotifications(notifications: McpNotification[]): string[] {
	if (notifications.length === 0) return []
	return [
		`$notification: ${JSON.stringify(notificationOutputValue(notifications))}`,
	]
}

function normalizeNotificationForOutput(
	notification: McpNotification,
): McpNotification {
	const normalized: McpNotification & { aggregatedCount?: number } = {
		method: notification.method,
	}
	const record = notification as McpNotification & { aggregatedCount?: number }
	if ('params' in notification) normalized.params = notification.params
	if (record.aggregatedCount !== undefined)
		normalized.aggregatedCount = record.aggregatedCount
	return normalized
}

function resultAsMergeableObject(
	result: unknown,
): Record<string, unknown> | undefined {
	if (!isMcpToolResult(result)) return isRecord(result) ? result : undefined

	const content = result.content ?? []
	if (content.length > 0) {
		const contentObject = contentAsMergeableObject(content)
		if (!contentObject) return undefined
		return addSupplementalStructuredContent(contentObject, result)
	}

	return isRecord(result.structuredContent)
		? result.structuredContent
		: undefined
}

function mergeNotifications(
	result: Record<string, unknown>,
	notifications: McpNotification[],
): Record<string, unknown> {
	return {
		...result,
		$notifications: notificationOutputValue(notifications),
	}
}

function notificationOutputValue(notifications: McpNotification[]): unknown {
	const oversize = notifications.find(
		(
			notification,
		): notification is Extract<McpNotification, { method: '$oversize' }> =>
			notification.method === '$oversize',
	)
	if (oversize)
		return `notifications oversize, saved to ${oversize.params.savedTo}`
	return notifications
}

function isStructuredDaemonResult(value: unknown): boolean {
	if (!isMcpToolResult(value)) return true
	const content = value.content ?? []
	if (
		content.some(
			(item) => item.type === 'text' && typeof item.text === 'string',
		)
	) {
		return false
	}
	return hasStructuredContent(value)
}

export async function formatMcpContent(
	content: McpContent[],
	outputFormat: McpxContext['output'] = 'optimized',
): Promise<string[]> {
	const output: string[] = []

	for (const item of content) {
		switch (item.type) {
			case 'text':
				if (typeof item.text === 'string')
					output.push(formatTextContent(item.text, outputFormat))
				break
			case 'resource':
				output.push(await formatEmbeddedResource(item.resource, outputFormat))
				break
			case 'resource_link':
				output.push(formatResourceLink(item, outputFormat))
				break
			default:
				output.push(await saveBinaryContent(item))
		}
	}

	return output
}

function formatStructuredContent(
	result: McpToolResult,
	output: McpxContext['output'],
): string {
	const value =
		output === 'raw' && result._meta !== undefined
			? { structuredContent: result.structuredContent, _meta: result._meta }
			: result.structuredContent

	return output === 'raw' ? JSON.stringify(value, null, 2) : formatYaml(value)
}

function formatSupplementalStructuredContent(
	result: McpToolResult,
	output: McpxContext['output'],
): string | undefined {
	if (!hasStructuredContent(result)) return undefined
	if (contentAlreadyRepresentsStructuredContent(result)) return undefined

	return output === 'raw'
		? `$structured: ${JSON.stringify(result.structuredContent)}`
		: formatYaml({ $structured: result.structuredContent })
}

function formatTextContent(
	text: string,
	output: McpxContext['output'],
): string {
	if (output === 'raw') return text

	const parsedJson = parseJsonText(text)
	if (parsedJson !== undefined) {
		return formatYaml(parsedJson)
	}

	return text
}

function contentAsMergeableObject(
	content: McpContent[],
): Record<string, unknown> | undefined {
	if (content.length !== 1) return undefined
	const [item] = content
	if (item?.type !== 'text' || typeof item.text !== 'string') return undefined
	const parsed = parseJsonText(item.text)
	return isRecord(parsed) ? parsed : undefined
}

function addSupplementalStructuredContent(
	resultObject: Record<string, unknown>,
	result: McpToolResult,
): Record<string, unknown> {
	if (
		!hasStructuredContent(result) ||
		contentAlreadyRepresentsStructuredContent(result)
	) {
		return resultObject
	}
	return {
		...resultObject,
		$structured: result.structuredContent,
	}
}

function contentAlreadyRepresentsStructuredContent(
	result: McpToolResult,
): boolean {
	if (!hasStructuredContent(result)) return false
	const content = result.content ?? []
	if (content.length !== 1) return false
	const [item] = content
	if (item?.type !== 'text' || typeof item.text !== 'string') return false
	const parsed = parseJsonText(item.text)
	return deepEqual(parsed, result.structuredContent)
}

function hasStructuredContent(result: McpToolResult): boolean {
	return (
		result.structuredContent !== undefined && result.structuredContent !== null
	)
}

function parseJsonText(text: string): unknown | undefined {
	const trimmed = text.trim()
	if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
	try {
		return JSON.parse(trimmed)
	} catch {
		return undefined
	}
}

async function saveBinaryContent(content: McpContent): Promise<string> {
	const bytes = contentBytes(content)
	const mimeType =
		typeof content.mimeType === 'string' ? content.mimeType : undefined
	const hash = createHash('sha256').update(bytes).digest('hex')
	const filePath = path.join(
		tmpdir(),
		`mcpx-${hash}${extensionForMimeType(mimeType)}`,
	)
	await fs.writeFile(filePath, bytes)
	return `file saved ${filePath}`
}

async function formatEmbeddedResource(
	resource: unknown,
	outputFormat: McpxContext['output'],
): Promise<string> {
	if (!isMcpContent(resource)) {
		return formatTextContent(JSON.stringify(resource, null, 2), outputFormat)
	}
	if (typeof resource.text === 'string') {
		return formatTextContent(resource.text, outputFormat)
	}
	return saveBinaryContent(resource)
}

function formatResourceLink(
	content: McpContent,
	outputFormat: McpxContext['output'],
): string {
	const link = omitUndefined({
		type: content.type,
		uri: content.uri,
		name: content.name,
		title: content.title,
		description: content.description,
		mimeType: content.mimeType,
		size: content.size,
	})
	return outputFormat === 'raw'
		? JSON.stringify(link, null, 2)
		: formatYaml(link)
}

function formatYaml(value: unknown): string {
	return stringifyYaml(value).trimEnd()
}

function contentBytes(content: McpContent): Buffer {
	if (typeof content.data === 'string') {
		return Buffer.from(content.data, 'base64')
	}
	if (typeof content.blob === 'string') {
		return Buffer.from(content.blob, 'base64')
	}
	if (typeof content.text === 'string') {
		return Buffer.from(content.text, 'utf8')
	}
	return Buffer.from(JSON.stringify(content, null, 2), 'utf8')
}

function extensionForMimeType(mimeType: string | undefined): string {
	switch (mimeType) {
		case 'image/png':
			return '.png'
		case 'image/jpeg':
		case 'image/jpg':
			return '.jpg'
		case 'image/svg+xml':
			return '.svg'
		case 'image/webp':
			return '.webp'
		case 'image/gif':
			return '.gif'
		case 'audio/mpeg':
			return '.mp3'
		case 'audio/wav':
			return '.wav'
		case 'audio/ogg':
			return '.ogg'
		case 'application/json':
			return '.json'
		case 'text/plain':
			return '.txt'
		default:
			return '.bin'
	}
}

function isMcpToolResult(value: unknown): value is McpToolResult {
	if (!value || typeof value !== 'object') return false
	const result = value as McpToolResult
	return Array.isArray(result.content) || 'structuredContent' in result
}

function isMcpContent(value: unknown): value is McpContent {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function deepEqual(left: unknown, right: unknown): boolean {
	return (
		JSON.stringify(sortComparable(left)) ===
		JSON.stringify(sortComparable(right))
	)
}

function sortComparable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortComparable)
	if (!isRecord(value)) return value
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, sortComparable(item)]),
	)
}

function omitUndefined(
	value: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).filter(([, item]) => item !== undefined),
	)
}
