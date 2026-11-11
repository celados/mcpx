import {
	DAEMON_PROTOCOL_VERSION,
	type NotificationMode,
} from './runtime-protocol'
import { MCPX_VERSION } from './version'

export { DAEMON_PROTOCOL_VERSION }
export type { NotificationMode }

export const NOTIFICATION_MODE_ENV = 'MCPX_NOTIFICATION_MODE'

export type McpNotification =
	| {
			method: 'notifications/progress'
			params: {
				progressToken: string | number
				progress: number
				total?: number
				message?: string
			}
			aggregatedCount?: number
	  }
	| { method: 'notifications/tools/list_changed'; params?: unknown }
	| { method: '$oversize'; params: { savedTo: string } }
	| { method: string; params?: unknown }

export type ClientMessage = {
	op: 'hello'
	protocolVersion: number
	clientVersion: string
}

/**
 * Every protocol version keeps the `hello` handshake and the `stop` intent
 * unchanged, and a `protocol-mismatch` answer names the daemon's own version:
 * that is how a newer client stops an older mcpxd to replace it.
 */
export type DaemonMessage =
	| { ok: true; protocolVersion?: number; result?: unknown }
	| {
			ok: false
			error: { code: string; message: string }
			/** The daemon's protocol, on `protocol-mismatch`. */
			protocolVersion?: number
	  }

export function notificationModeFromEnv(): NotificationMode {
	const raw = process.env[NOTIFICATION_MODE_ENV]
	if (!raw || raw === 'buffer') return 'buffer'
	if (raw === 'discard') return 'discard'
	throw new Error(
		`Invalid ${NOTIFICATION_MODE_ENV} value "${raw}". Expected "buffer" or "discard".`,
	)
}

export function helloMessage(
	protocolVersion: number = DAEMON_PROTOCOL_VERSION,
): ClientMessage {
	return {
		op: 'hello',
		protocolVersion,
		clientVersion: MCPX_VERSION,
	}
}
