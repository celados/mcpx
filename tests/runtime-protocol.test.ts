import { describe, expect, it } from 'bun:test'

import {
	DAEMON_PROTOCOL_VERSION,
	RuntimeConnectionState,
	createHello,
	parseRuntimeIntent,
} from '../src/runtime-protocol'

describe('Runtime protocol v3', () => {
	it('accepts one handshake followed by one operation', () => {
		const connection = new RuntimeConnectionState()

		expect(connection.accept(createHello())).toEqual({ kind: 'hello' })
		expect(
			connection.accept({
				requestId: 'request-1',
				op: 'call',
				serverName: 'fixture',
				toolName: 'search',
				input: { query: 'runtime' },
			}),
		).toEqual({
			kind: 'intent',
			intent: {
				requestId: 'request-1',
				op: 'call',
				serverName: 'fixture',
				toolName: 'search',
				input: { query: 'runtime' },
			},
		})
		expect(connection.accept({ requestId: 'request-2', op: 'status' })).toEqual(
			{
				kind: 'error',
				error: {
					code: 'connection-complete',
					message: 'A Runtime connection accepts exactly one operation.',
				},
			},
		)
	})

	it('rejects protocol mismatch and operations before the handshake', () => {
		const beforeHandshake = new RuntimeConnectionState()
		expect(
			beforeHandshake.accept({ requestId: 'request-1', op: 'status' }),
		).toMatchObject({ kind: 'error', error: { code: 'handshake-required' } })

		const mismatch = new RuntimeConnectionState()
		expect(
			mismatch.accept({
				kind: 'hello',
				protocolVersion: DAEMON_PROTOCOL_VERSION - 1,
				clientVersion: '0.0.0',
			}),
		).toMatchObject({ kind: 'error', error: { code: 'protocol-mismatch' } })
	})

	it('parses only the final intent shapes without credential material', () => {
		expect(
			parseRuntimeIntent({
				requestId: 'request-1',
				op: 'refreshServers',
				serverNames: ['fixture'],
			}),
		).toEqual({
			requestId: 'request-1',
			op: 'refreshServers',
			serverNames: ['fixture'],
		})

		expect(
			parseRuntimeIntent({
				requestId: 'request-2',
				op: 'call',
				serverName: 'fixture',
				toolName: 'search',
				input: {},
				headers: { Authorization: 'secret' },
			}),
		).toEqual({
			code: 'invalid-frame',
			message: 'Invalid Runtime intent.',
		})
	})
})
