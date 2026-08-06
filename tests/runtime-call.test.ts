import { describe, expect, it } from 'bun:test'

import type { RuntimeCaller } from '../src/runtime-caller'

import { CancelableFifo, RuntimeCall } from '../src/runtime-call'
import { createInMemoryRuntimeCaller } from '../src/runtime-caller'

describe('caller-owned Runtime Call lifecycle', () => {
	it('removes a disconnected queued Call before activation', async () => {
		const fifo = new CancelableFifo()
		const firstCaller = createInMemoryRuntimeCaller('first')
		const queuedCaller = createInMemoryRuntimeCaller('queued')
		const first = new RuntimeCall(firstCaller)
		const queued = new RuntimeCall(queuedCaller)
		const reached: string[] = []
		let releaseFirst = () => {}
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})

		fifo.enqueue(first, async () => {
			reached.push('first')
			await firstBlocked
			return 'first-result'
		})
		fifo.enqueue(queued, async () => {
			reached.push('queued')
			return 'queued-result'
		})
		await waitFor(() => first.state === 'active')

		queuedCaller.disconnect()
		releaseFirst()
		await fifo.idle()

		expect(reached).toEqual(['first'])
		expect(queued.state).toBe('terminal')
		expect(queued.cancellationCause).toBe('caller-disconnected')
		expect(queuedCaller.frames).toEqual([])
		expect(fifo.status()).toEqual({ activeCalls: 0, queuedCalls: 0 })
	})

	it('aborts an active Call exactly once and never writes to its dead caller', async () => {
		const fifo = new CancelableFifo()
		const caller = createInMemoryRuntimeCaller('active')
		const call = new RuntimeCall(caller)
		let abortEvents = 0

		fifo.enqueue(call, (signal) => {
			return new Promise((_resolve, reject) => {
				signal.addEventListener(
					'abort',
					() => {
						abortEvents += 1
						reject(signal.reason)
					},
					{ once: true },
				)
			})
		})
		await waitFor(() => call.state === 'active')

		caller.disconnect()
		caller.disconnect()
		await fifo.idle()

		expect(abortEvents).toBe(1)
		expect(call.cancellationCause).toBe('caller-disconnected')
		expect(caller.frames).toEqual([])
	})

	it('removes the disconnect listener before normal completion', async () => {
		const fifo = new CancelableFifo()
		const caller = createInMemoryRuntimeCaller('completed')
		const call = new RuntimeCall(caller)

		fifo.enqueue(call, async () => 'done')
		await fifo.idle()
		caller.disconnect()

		expect(call.signal.aborted).toBe(false)
		expect(call.cancellationCause).toBeUndefined()
		expect(caller.frames).toEqual([
			{ requestId: 'completed', kind: 'result', result: 'done' },
		])
	})

	it('keeps timeout distinct from caller disconnect in owned state', async () => {
		const fifo = new CancelableFifo()
		const caller = createInMemoryRuntimeCaller('timed-out')
		const call = new RuntimeCall(caller)

		fifo.enqueue(call, (signal) => {
			return new Promise((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), {
					once: true,
				})
			})
		})
		await waitFor(() => call.state === 'active')
		await call.cancel('timeout')
		await fifo.idle()

		expect(call.cancellationCause).toBe('timeout')
		expect(caller.frames).toEqual([
			{
				requestId: 'timed-out',
				kind: 'error',
				error: { code: 'timeout', message: 'Runtime Call timed out.' },
			},
		])
	})

	it('continues FIFO execution after failure, timeout, and cancellation', async () => {
		const fifo = new CancelableFifo()
		const order: string[] = []
		const failed = new RuntimeCall(createInMemoryRuntimeCaller('failed'))
		const timedOut = new RuntimeCall(createInMemoryRuntimeCaller('timeout'))
		const cancelledCaller = createInMemoryRuntimeCaller('cancelled')
		const cancelled = new RuntimeCall(cancelledCaller)
		const succeeded = new RuntimeCall(createInMemoryRuntimeCaller('succeeded'))

		fifo.enqueue(failed, async () => {
			order.push('failed')
			throw new Error('fixture failure')
		})
		fifo.enqueue(timedOut, async (signal) => {
			order.push('timeout')
			await timedOut.cancel('timeout')
			throw signal.reason
		})
		fifo.enqueue(cancelled, async () => {
			order.push('cancelled')
			return null
		})
		cancelledCaller.disconnect()
		fifo.enqueue(succeeded, async () => {
			order.push('succeeded')
			return 'ok'
		})

		await fifo.idle()

		expect(order).toEqual(['failed', 'timeout', 'succeeded'])
		expect(fifo.status()).toEqual({ activeCalls: 0, queuedCalls: 0 })
	})

	it('never activates a Call whose caller disconnected before construction', async () => {
		const caller = createInMemoryRuntimeCaller('already-gone')
		caller.disconnect()
		const call = new RuntimeCall(caller)
		const fifo = new CancelableFifo()
		let activated = false

		fifo.enqueue(call, async () => {
			activated = true
		})
		await fifo.idle()

		expect(activated).toBe(false)
		expect(call.cancellationCause).toBe('caller-disconnected')
	})

	it('releases FIFO ownership before terminal socket delivery completes', async () => {
		let releaseSend = () => {}
		const blockedSend = new Promise<void>((resolve) => {
			releaseSend = resolve
		})
		const blockedCaller: RuntimeCaller = {
			id: 'blocked',
			onDisconnect: () => () => {},
			requestInput: async () => undefined,
			send: () => blockedSend,
		}
		const fifo = new CancelableFifo()
		let secondRan = false

		fifo.enqueue(new RuntimeCall(blockedCaller), async () => 'first')
		fifo.enqueue(
			new RuntimeCall(createInMemoryRuntimeCaller('second')),
			async () => {
				secondRan = true
				return 'second'
			},
		)
		await fifo.idle()

		expect(secondRan).toBe(true)
		expect(fifo.status()).toEqual({ activeCalls: 0, queuedCalls: 0 })
		releaseSend()
	})
})

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return
		await Bun.sleep(1)
	}
	throw new Error('Condition was not met.')
}
