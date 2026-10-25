import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const server = new McpServer({ name: 'mcpx-stdio-fixture', version: '1.0.0' })
let counter = 0

server.registerTool(
	'echo',
	{
		title: 'Echo',
		description: 'Echo a fixed response',
		inputSchema: z.object({}),
	},
	async () => ({
		content: [{ type: 'text', text: 'ok' }],
	}),
)

server.registerTool(
	'pid',
	{
		title: 'PID',
		description: 'Return the fixture process id',
		inputSchema: z.object({}),
	},
	async () => ({
		content: [{ type: 'text', text: String(process.pid) }],
	}),
)

server.registerTool(
	'cwd',
	{
		title: 'CWD',
		description: 'Return the fixture process working directory',
		inputSchema: z.object({}),
	},
	async () => ({
		content: [{ type: 'text', text: process.cwd() }],
	}),
)

server.registerTool(
	'increment',
	{
		title: 'Increment',
		description: 'Increment in-process state',
		inputSchema: z.object({}),
	},
	async () => {
		counter += 1
		return {
			content: [{ type: 'text', text: String(counter) }],
		}
	},
)

server.registerTool(
	'slow',
	{
		title: 'Slow',
		description: 'Return after a short delay',
		inputSchema: z.object({}),
	},
	async () => {
		await new Promise((resolve) => setTimeout(resolve, 100))
		return {
			content: [{ type: 'text', text: 'slow-ok' }],
		}
	},
)

await server.connect(new StdioServerTransport())
