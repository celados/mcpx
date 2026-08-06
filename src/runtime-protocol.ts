import { MCPX_VERSION } from './version'

export const DAEMON_PROTOCOL_VERSION = 3

export type NotificationMode = 'buffer' | 'discard'

export type RuntimeErrorCode =
	| 'caller-disconnected'
	| 'cancelled'
	| 'connection-complete'
	| 'handshake-required'
	| 'invalid-frame'
	| 'operation-failed'
	| 'protocol-mismatch'
	| 'reauth-required'
	| 'timeout'

export type RuntimeError = {
	code: RuntimeErrorCode
	message: string
}

export type RuntimeEvent = {
	type: string
	message?: string
	data?: unknown
}

export type RuntimeInputRequest = {
	inputId: string
	type: 'oauth-client'
	serverName: string
	redirectUri: string
	issuer: string
	scopes: string[]
}

export type RuntimeInputFrame = {
	kind: 'input'
	requestId: string
	inputId: string
	value: unknown
}

export function isRuntimeInputFrame(
	value: unknown,
): value is RuntimeInputFrame {
	return (
		isRecord(value) &&
		hasExactly(value, ['kind', 'requestId', 'inputId', 'value']) &&
		value.kind === 'input' &&
		isNonEmptyString(value.requestId) &&
		isNonEmptyString(value.inputId)
	)
}

export type RuntimeFrame =
	| { requestId: string; kind: 'event'; event: RuntimeEvent }
	| { requestId: string; kind: 'result'; result: unknown }
	| { requestId: string; kind: 'error'; error: RuntimeError }

export type RuntimeIntent =
	| { requestId: string; op: 'registrySnapshot' }
	| {
			requestId: string
			op: 'call'
			serverName: string
			toolName: string
			input: Record<string, unknown>
			notificationMode?: NotificationMode
	  }
	| {
			requestId: string
			op: 'addServer'
			serverName: string
			transport: 'http' | 'stdio'
			url?: string
			bearer?: string[]
			command?: string
			args?: string[]
			env?: Record<string, string>
	  }
	| { requestId: string; op: 'removeServers'; serverNames: string[] }
	| { requestId: string; op: 'refreshServers'; serverNames?: string[] }
	| { requestId: string; op: 'status' }
	| { requestId: string; op: 'stop' }

export type RuntimeHello = {
	kind: 'hello'
	protocolVersion: number
	clientVersion: string
}

export type RuntimeConnectionInput = RuntimeHello | RuntimeIntent

export type RuntimeConnectionAcceptance =
	| { kind: 'hello' }
	| { kind: 'intent'; intent: RuntimeIntent }
	| { kind: 'error'; error: RuntimeError }

export function createHello(): RuntimeHello {
	return {
		kind: 'hello',
		protocolVersion: DAEMON_PROTOCOL_VERSION,
		clientVersion: MCPX_VERSION,
	}
}

export function parseRuntimeIntent(
	value: unknown,
): RuntimeIntent | RuntimeError {
	if (!isRecord(value) || !isNonEmptyString(value.requestId)) {
		return invalidFrame()
	}

	switch (value.op) {
		case 'registrySnapshot':
		case 'status':
		case 'stop':
			return hasExactly(value, ['requestId', 'op'])
				? (value as RuntimeIntent)
				: invalidFrame()
		case 'call': {
			const allowed = [
				'requestId',
				'op',
				'serverName',
				'toolName',
				'input',
				'notificationMode',
			]
			if (
				!hasOnly(value, allowed) ||
				!hasRequired(value, allowed.slice(0, 5)) ||
				!isNonEmptyString(value.serverName) ||
				!isNonEmptyString(value.toolName) ||
				!isRecord(value.input) ||
				(value.notificationMode !== undefined &&
					value.notificationMode !== 'buffer' &&
					value.notificationMode !== 'discard')
			) {
				return invalidFrame()
			}
			return value as RuntimeIntent
		}
		case 'addServer': {
			const allowed = [
				'requestId',
				'op',
				'serverName',
				'transport',
				'url',
				'bearer',
				'command',
				'args',
				'env',
			]
			if (
				!hasOnly(value, allowed) ||
				!hasRequired(value, ['requestId', 'op', 'serverName', 'transport']) ||
				!isNonEmptyString(value.serverName) ||
				(value.transport !== 'http' && value.transport !== 'stdio') ||
				(value.url !== undefined && !isNonEmptyString(value.url)) ||
				(value.command !== undefined && !isNonEmptyString(value.command)) ||
				(value.bearer !== undefined && !isStringArray(value.bearer)) ||
				(value.args !== undefined && !isStringArray(value.args)) ||
				(value.env !== undefined && !isStringRecord(value.env))
			) {
				return invalidFrame()
			}
			return value as RuntimeIntent
		}
		case 'removeServers':
			return hasExactly(value, ['requestId', 'op', 'serverNames']) &&
				isStringArray(value.serverNames)
				? (value as RuntimeIntent)
				: invalidFrame()
		case 'refreshServers':
			return hasOnly(value, ['requestId', 'op', 'serverNames']) &&
				hasRequired(value, ['requestId', 'op']) &&
				(value.serverNames === undefined || isStringArray(value.serverNames))
				? (value as RuntimeIntent)
				: invalidFrame()
		default:
			return invalidFrame()
	}
}

export class RuntimeConnectionState {
	#state: 'awaiting-hello' | 'ready' | 'complete' = 'awaiting-hello'

	accept(value: unknown): RuntimeConnectionAcceptance {
		if (this.#state === 'complete') {
			return {
				kind: 'error',
				error: {
					code: 'connection-complete',
					message: 'A Runtime connection accepts exactly one operation.',
				},
			}
		}

		if (this.#state === 'awaiting-hello') {
			if (!isRuntimeHello(value)) {
				return {
					kind: 'error',
					error: {
						code: 'handshake-required',
						message: 'A Runtime connection must begin with a handshake.',
					},
				}
			}
			if (value.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
				this.#state = 'complete'
				return {
					kind: 'error',
					error: {
						code: 'protocol-mismatch',
						message: `Unsupported Runtime protocol ${value.protocolVersion}; expected ${DAEMON_PROTOCOL_VERSION}.`,
					},
				}
			}
			this.#state = 'ready'
			return { kind: 'hello' }
		}

		const intent = parseRuntimeIntent(value)
		if ('code' in intent) return { kind: 'error', error: intent }
		this.#state = 'complete'
		return { kind: 'intent', intent }
	}
}

function isRuntimeHello(value: unknown): value is RuntimeHello {
	return (
		isRecord(value) &&
		hasExactly(value, ['kind', 'protocolVersion', 'clientVersion']) &&
		value.kind === 'hello' &&
		typeof value.protocolVersion === 'number' &&
		isNonEmptyString(value.clientVersion)
	)
}

function invalidFrame(): RuntimeError {
	return { code: 'invalid-frame', message: 'Invalid Runtime intent.' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isNonEmptyString)
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every(isNonEmptyString)
}

function hasExactly(value: Record<string, unknown>, keys: string[]): boolean {
	return hasOnly(value, keys) && hasRequired(value, keys)
}

function hasOnly(value: Record<string, unknown>, keys: string[]): boolean {
	const allowed = new Set(keys)
	return Object.keys(value).every((key) => allowed.has(key))
}

function hasRequired(value: Record<string, unknown>, keys: string[]): boolean {
	return keys.every((key) => Object.hasOwn(value, key))
}
