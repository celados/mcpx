import readline from 'node:readline'

const pending = new Map()
const completed = new Map()

function event(value) {
	process.stderr.write(`${JSON.stringify(value)}\n`)
}

function send(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`)
}

function result(id, text) {
	send({
		jsonrpc: '2.0',
		id,
		result: { content: [{ type: 'text', text }] },
	})
}

function complete(entry, text) {
	pending.delete(entry.id)
	completed.set(entry.id, entry.scenario)
	event({ event: 'response', id: entry.id, scenario: entry.scenario })
	result(entry.id, text)
}

function startCall(message) {
	const scenario = message.params?.arguments?.scenario
	const entry = { id: message.id, scenario, timer: undefined }
	pending.set(message.id, entry)
	event({ event: 'call', id: message.id, scenario })

	if (scenario === 'complete-before-cancel') {
		entry.timer = setTimeout(() => complete(entry, scenario), 5)
		return
	}
	if (scenario === 'ignore') {
		entry.timer = setTimeout(() => complete(entry, scenario), 80)
		return
	}

	// A long fallback makes a missing cancellation observable without hanging forever.
	entry.timer = setTimeout(() => complete(entry, `${scenario}-fallback`), 2_000)
}

function cancel(message) {
	const requestId = message.params?.requestId
	const entry = pending.get(requestId)
	event({
		event: 'cancel',
		requestId,
		reason: message.params?.reason,
		scenario: entry?.scenario ?? completed.get(requestId) ?? 'unknown',
		pending: Boolean(entry),
	})
	if (!entry) return
	if (entry.scenario === 'acknowledge') {
		clearTimeout(entry.timer)
		pending.delete(requestId)
		event({ event: 'work-stopped', requestId, scenario: entry.scenario })
		return
	}
	if (entry.scenario === 'race') {
		clearTimeout(entry.timer)
		queueMicrotask(() => complete(entry, entry.scenario))
	}
}

function handle(message) {
	event({ event: 'message', method: message.method, id: message.id })
	if (message.method === 'initialize') {
		send({
			jsonrpc: '2.0',
			id: message.id,
			result: {
				protocolVersion: message.params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: 'cancellation-stdio-fixture', version: '1.0.0' },
			},
		})
		return
	}
	if (message.method === 'notifications/initialized') return
	if (message.method === 'tools/list') {
		send({
			jsonrpc: '2.0',
			id: message.id,
			result: {
				tools: [
					{ name: 'echo', inputSchema: { type: 'object', properties: {} } },
					{ name: 'fail', inputSchema: { type: 'object', properties: {} } },
					{
						name: 'controlled',
						inputSchema: {
							type: 'object',
							properties: { scenario: { type: 'string' } },
							required: ['scenario'],
						},
					},
				],
			},
		})
		return
	}
	if (message.method === 'notifications/cancelled') {
		cancel(message)
		return
	}
	if (message.method !== 'tools/call') return
	if (message.params?.name === 'echo') {
		result(message.id, 'echo-ok')
		return
	}
	if (message.params?.name === 'fail') {
		send({
			jsonrpc: '2.0',
			id: message.id,
			error: { code: -32000, message: 'fixture failure' },
		})
		return
	}
	startCall(message)
}

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => handle(JSON.parse(line)))
