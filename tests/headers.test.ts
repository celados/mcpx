import { describe, expect, it } from 'bun:test'

import type { HttpServerConfig } from '../src/types'

import { authFromBearerValues } from '../src/bearer'
import { resolveHeaders } from '../src/headers'

describe('headers', () => {
	it('parses literal and referenced bearer credentials', () => {
		expect(
			authFromBearerValues([
				'env:FIRST_TOKEN',
				'${SECOND_TOKEN}',
				'sk_literal',
			]),
		).toEqual({
			kind: 'bearer',
			credentials: [
				{ kind: 'env', name: 'FIRST_TOKEN' },
				{ kind: 'env', name: 'SECOND_TOKEN' },
				{ kind: 'literal', value: 'sk_literal' },
			],
			strategy: 'round-robin',
			confidence: 'configured',
		})
	})

	it('fails fast when a bearer env reference is missing', async () => {
		const previous = process.env.MISSING_MCPX_TEST_TOKEN
		delete process.env.MISSING_MCPX_TEST_TOKEN
		const server = bearerServer(['env:MISSING_MCPX_TEST_TOKEN'])

		try {
			await expect(resolveHeaders(server)).rejects.toThrow(
				/MISSING_MCPX_TEST_TOKEN/,
			)
		} finally {
			if (previous === undefined) {
				delete process.env.MISSING_MCPX_TEST_TOKEN
			} else {
				process.env.MISSING_MCPX_TEST_TOKEN = previous
			}
		}
	})
})

function bearerServer(values: string[]): HttpServerConfig {
	const auth = authFromBearerValues(values)
	if (!auth || auth.kind !== 'bearer') throw new Error('Expected bearer auth.')
	return {
		url: 'https://mcp.example.com/mcp',
		auth,
	}
}
