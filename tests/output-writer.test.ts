import { describe, expect, it } from 'bun:test'
import { PassThrough, Writable } from 'node:stream'

import { writeLine } from '../src/output-writer'

describe('output writer', () => {
	it('waits until a backpressured stream consumes the complete line', async () => {
		const stream = new PassThrough({ highWaterMark: 16 })
		const chunks: Buffer[] = []
		let finished = false
		const writing = writeLine(stream, 'x'.repeat(64 * 1024)).then(() => {
			finished = true
		})

		await Bun.sleep(10)
		expect(finished).toBeFalse()

		stream.on('data', (chunk) => chunks.push(chunk))
		await writing
		expect(Buffer.concat(chunks).toString()).toBe(`${'x'.repeat(64 * 1024)}\n`)
	})

	it('treats a closed downstream pipe as a normal early exit', async () => {
		const stream = failingStream(errorWithCode('EPIPE'))

		await expect(writeLine(stream, 'ignored')).resolves.toBeUndefined()
		await expect(writeLine(stream, 'also ignored')).resolves.toBeUndefined()
	})

	it('preserves unexpected output failures', async () => {
		const stream = failingStream(errorWithCode('EIO'))

		await expect(writeLine(stream, 'failed')).rejects.toMatchObject({
			code: 'EIO',
		})
	})
})

function failingStream(error: Error): Writable {
	return new Writable({
		write(_chunk, _encoding, callback) {
			callback(error)
		},
	})
}

function errorWithCode(code: string): Error {
	return Object.assign(new Error(code), { code })
}
