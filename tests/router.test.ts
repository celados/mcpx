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
			'@refresh',
			'@remove',
			'@skill',
		])
	})

	it('describes server groups by tool count', () => {
		expect(__test.describeServerTools(0)).toBe('(0 tools)')
		expect(__test.describeServerTools(1)).toBe('(1 tool)')
		expect(__test.describeServerTools(123)).toBe('(123 tools)')
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
