import { describe, expect, it } from 'bun:test'

import { createInMemoryRuntimeCaller } from '../src/runtime-caller'

describe('RuntimeCaller', () => {
	it('keeps every frame correlated to its request', async () => {
		const caller = createInMemoryRuntimeCaller('request-1')

		await caller.send({
			requestId: 'request-1',
			kind: 'event',
			event: { type: 'progress', message: 'working' },
		})
		await caller.send({
			requestId: 'request-1',
			kind: 'result',
			result: { ok: true },
		})

		expect(caller.frames).toEqual([
			{
				requestId: 'request-1',
				kind: 'event',
				event: { type: 'progress', message: 'working' },
			},
			{
				requestId: 'request-1',
				kind: 'result',
				result: { ok: true },
			},
		])
	})

	it('rejects mismatched request ids and every frame after a terminal', async () => {
		const caller = createInMemoryRuntimeCaller('request-1')

		expect(
			caller.send({
				requestId: 'request-2',
				kind: 'result',
				result: null,
			}),
		).rejects.toThrow('does not match caller request-1')

		await caller.send({
			requestId: 'request-1',
			kind: 'error',
			error: { code: 'operation-failed', message: 'failed' },
		})
		expect(
			caller.send({
				requestId: 'request-1',
				kind: 'result',
				result: null,
			}),
		).rejects.toThrow('already received a terminal frame')
	})

	it('removes disconnect subscriptions independently', () => {
		const caller = createInMemoryRuntimeCaller('request-1')
		let first = 0
		let second = 0
		const unsubscribe = caller.onDisconnect(() => first++)
		caller.onDisconnect(() => second++)

		unsubscribe()
		caller.disconnect()

		expect(first).toBe(0)
		expect(second).toBe(1)
	})

	it('immediately notifies subscribers that arrive after disconnect', () => {
		const caller = createInMemoryRuntimeCaller('request-1')
		caller.disconnect()
		let notifications = 0

		caller.onDisconnect(() => notifications++)

		expect(notifications).toBe(1)
	})
})
