import type { Writable } from 'node:stream'

export type OutputWriter = (message: string) => Promise<void>

const brokenPipes = new WeakSet<Writable>()

export function stdoutWriter(message: string): Promise<void> {
	return writeLine(process.stdout, message)
}

export function stderrWriter(message: string): Promise<void> {
	return writeLine(process.stderr, message)
}

export function writeLine(stream: Writable, message: string): Promise<void> {
	if (brokenPipes.has(stream)) return Promise.resolve()

	return new Promise((resolve, reject) => {
		let settled = false

		const finish = (error?: Error | null) => {
			if (settled) return
			settled = true
			stream.off('error', finish)
			if (error) stream.once('error', () => {})

			// A downstream command may intentionally stop reading before mcpx finishes.
			// Treat that Unix pipeline contract as successful instead of crashing or spinning.
			if (isBrokenPipe(error)) {
				brokenPipes.add(stream)
				resolve()
				return
			}
			if (error) {
				reject(error)
				return
			}
			resolve()
		}

		stream.once('error', finish)
		stream.write(`${message}\n`, finish)
	})
}

function isBrokenPipe(error: Error | null | undefined): boolean {
	return !!error && 'code' in error && error.code === 'EPIPE'
}
