import { describe, expect, it } from 'bun:test'

import { AuthenticationCoordinator } from '../src/authentication-coordinator'
import { createInMemoryRuntimeCaller } from '../src/runtime-caller'

describe('Runtime Authentication Flow coordinator', () => {
	it('shares one flow and one persistence write across five callers', async () => {
		const coordinator = new AuthenticationCoordinator()
		const callers = Array.from({ length: 5 }, (_, index) =>
			createInMemoryRuntimeCaller(`refresh-${index}`),
		)
		let starts = 0
		let writes = 0

		const outcomes = await Promise.all(
			callers.map((caller) =>
				coordinator.join('oauth:fixture', caller, {
					start: async () => {
						starts += 1
						await Bun.sleep(5)
						return { accessToken: 'internal-secret' }
					},
					persist: async () => {
						writes += 1
					},
				}),
			),
		)

		expect(starts).toBe(1)
		expect(writes).toBe(1)
		expect(outcomes).toEqual(callers.map(() => ({ status: 'completed' })))
		expect(callers.flatMap((caller) => caller.frames)).toEqual([])
	})

	it('keeps the shared flow alive while one waiter remains', async () => {
		const coordinator = new AuthenticationCoordinator()
		const first = createInMemoryRuntimeCaller('first')
		const second = createInMemoryRuntimeCaller('second')
		let flowSignal: AbortSignal | undefined
		let finish = (_value: string) => {}
		const result = new Promise<string>((resolve) => {
			finish = resolve
		})
		const flow = {
			start: async (signal: AbortSignal) => {
				flowSignal = signal
				return result
			},
			persist: async () => {},
		}
		const firstRefresh = coordinator.join('oauth:fixture', first, flow)
		const secondRefresh = coordinator.join('oauth:fixture', second, flow)
		await waitFor(() => flowSignal !== undefined)

		first.disconnect()
		expect(flowSignal?.aborted).toBe(false)
		finish('rotated')
		expect(await firstRefresh).toEqual({ status: 'disconnected' })
		expect(await secondRefresh).toEqual({ status: 'completed' })

		expect(first.frames).toEqual([])
		expect(second.frames).toEqual([])
	})

	it('aborts and settles the flow when its final waiter disconnects', async () => {
		const coordinator = new AuthenticationCoordinator()
		const caller = createInMemoryRuntimeCaller('only-waiter')
		let callbackOpen = false
		const refresh = coordinator.join('oauth:fixture', caller, {
			start: (signal) =>
				new Promise((_resolve, reject) => {
					callbackOpen = true
					signal.addEventListener(
						'abort',
						() => {
							callbackOpen = false
							reject(signal.reason)
						},
						{ once: true },
					)
				}),
			persist: async () => {},
		})
		await waitFor(() => callbackOpen)

		caller.disconnect()
		expect(await refresh).toEqual({ status: 'disconnected' })

		expect(callbackOpen).toBe(false)
		expect(caller.frames).toEqual([])
		expect(coordinator.activeFlows()).toBe(0)
	})

	it('clears owned timeout resources after timeout and rejection', async () => {
		const coordinator = new AuthenticationCoordinator({ timeoutMs: 5 })
		const timedOut = createInMemoryRuntimeCaller('timed-out')
		let timeoutResourceOpen = false
		const timeout = coordinator.join('oauth:timeout', timedOut, {
			start: (signal) =>
				new Promise((_resolve, reject) => {
					timeoutResourceOpen = true
					signal.addEventListener(
						'abort',
						() => {
							timeoutResourceOpen = false
							reject(signal.reason)
						},
						{ once: true },
					)
				}),
			persist: async () => {},
		})
		expect(timeout).rejects.toMatchObject({ code: 'timeout' })
		await timeout.catch(() => {})

		const rejected = createInMemoryRuntimeCaller('rejected')
		const rejection = coordinator.join('oauth:rejected', rejected, {
			start: () => {
				throw new Error('provider rejected')
			},
			persist: async () => {},
		})
		expect(rejection).rejects.toMatchObject({
			code: 'operation-failed',
			message: 'provider rejected',
		})
		await rejection.catch(() => {})

		expect(timeoutResourceOpen).toBe(false)
		expect(timedOut.frames).toEqual([])
		expect(rejected.frames).toEqual([])
		expect(coordinator.activeFlows()).toBe(0)
	})

	it('cancels and awaits every flow before refusing shutdown-era admission', async () => {
		const coordinator = new AuthenticationCoordinator()
		const caller = createInMemoryRuntimeCaller('shutdown')
		let started = false
		const waiting = coordinator.join('credential', caller, {
			start: async (signal) => {
				started = true
				return new Promise<string>((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(signal.reason), {
						once: true,
					})
				})
			},
			persist: async () => {},
		})
		await waitFor(() => started)

		await coordinator.close()

		await expect(waiting).rejects.toThrow('stopping')
		expect(coordinator.activeFlows()).toBe(0)
		await expect(
			coordinator.join('late', createInMemoryRuntimeCaller('late'), {
				start: async () => 'late',
				persist: async () => {},
			}),
		).rejects.toThrow('stopping')
	})
})

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return
		await Bun.sleep(1)
	}
	throw new Error('Condition was not met.')
}
