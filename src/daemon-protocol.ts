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

export type DaemonMessage =
	| { ok: true; protocolVersion?: number; result?: unknown }
	| { ok: false; error: { code: string; message: string } }

export function notificationModeFromEnv(): NotificationMode {
	const raw = process.env[NOTIFICATION_MODE_ENV]
	if (!raw || raw === 'buffer') return 'buffer'
	if (raw === 'discard') return 'discard'
	throw new Error(
		`Invalid ${NOTIFICATION_MODE_ENV} value "${raw}". Expected "buffer" or "discard".`,
	)
}

export function helloMessage(): ClientMessage {
	return {
		op: 'hello',
		protocolVersion: DAEMON_PROTOCOL_VERSION,
		clientVersion: MCPX_VERSION,
	}
}
