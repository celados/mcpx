import { describe, expect, it } from 'bun:test'

import {
	NOTIFICATION_MODE_ENV,
	notificationModeFromEnv,
} from '../src/daemon-protocol'

describe('daemon protocol adapter', () => {
	it('defaults notification buffering unless explicitly discarded', () => {
		const previous = process.env[NOTIFICATION_MODE_ENV]
		try {
			delete process.env[NOTIFICATION_MODE_ENV]
			expect(notificationModeFromEnv()).toBe('buffer')
			process.env[NOTIFICATION_MODE_ENV] = 'discard'
			expect(notificationModeFromEnv()).toBe('discard')
		} finally {
			if (previous === undefined) delete process.env[NOTIFICATION_MODE_ENV]
			else process.env[NOTIFICATION_MODE_ENV] = previous
		}
	})

	it('rejects invalid notification mode env values', () => {
		const previous = process.env[NOTIFICATION_MODE_ENV]
		try {
			process.env[NOTIFICATION_MODE_ENV] = 'off'
			expect(() => notificationModeFromEnv()).toThrow(
				'Invalid MCPX_NOTIFICATION_MODE value "off". Expected "buffer" or "discard".',
			)
		} finally {
			if (previous === undefined) delete process.env[NOTIFICATION_MODE_ENV]
			else process.env[NOTIFICATION_MODE_ENV] = previous
		}
	})
})
