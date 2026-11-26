import { describe, expect, it } from 'bun:test'

import { __test } from '../src/router'

describe('router', () => {
	it('keeps mcpx control commands under the @ namespace', () => {
		const router = __test.buildRouter({
			servers: {},
		})

		expect(Object.keys(router).sort()).toEqual([
			'@add',
			'@daemon',
			'@login',
			'@remove',
			'@skill-install',
		])
	})

	it('describes server groups by what the server says it is for', () => {
		expect(
			__test.describeServer('sentry', {
				description: 'Search and triage Sentry issues.',
			}),
		).toBe('Search and triage Sentry issues.')
		// An older cache entry has no description until its next listing.
		expect(__test.describeServer('sentry', {})).toBe('sentry')
		expect(__test.describeServer('sentry', { description: '' })).toBe('sentry')
	})

	it('includes title and safety annotations in tool descriptions', () => {
		expect(
			__test.describeTool(
				{
					name: 'close_page',
					title: 'Close Page',
					description: 'Close a browser page',
					annotations: { destructiveHint: true, idempotentHint: true },
				},
				'browser',
			),
		).toBe('Close Page — Close a browser page — [destructive, idempotent]')
	})

	it('builds stdio discovery options from @add input', () => {
		expect(
			__test.addDiscoverOptions('open-design', {
				name: 'open-design',
				transport: 'stdio',
				command: 'node',
				args: ['/path/to/cli.js', 'mcp'],
				env: { OPEN_DESIGN_TOKEN: 'test' },
			}),
		).toEqual({
			name: 'open-design',
			transport: 'stdio',
			command: 'node',
			args: ['/path/to/cli.js', 'mcp'],
			env: { OPEN_DESIGN_TOKEN: 'test' },
		})
	})

	it('keeps @add HTTP as the default transport', () => {
		expect(
			__test.addDiscoverOptions('posthog', {
				name: 'posthog',
				url: 'https://mcp.posthog.com/mcp',
			}),
		).toEqual({
			name: 'posthog',
			transport: 'http',
			url: 'https://mcp.posthog.com/mcp',
		})
	})

	it('builds HTTP discovery options with repeatable bearer credentials', () => {
		expect(
			__test.addDiscoverOptions('posthog', {
				name: 'posthog',
				url: 'https://mcp.posthog.com/mcp',
				bearer: ['env:POSTHOG_TOKEN_A', 'env:POSTHOG_TOKEN_B'],
			}),
		).toEqual({
			name: 'posthog',
			transport: 'http',
			url: 'https://mcp.posthog.com/mcp',
			bearer: ['env:POSTHOG_TOKEN_A', 'env:POSTHOG_TOKEN_B'],
		})
	})
})
