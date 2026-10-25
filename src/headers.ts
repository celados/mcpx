import type { HttpServerConfig } from './types'

import { resolveBearerHeader } from './bearer'

export async function resolveHeaders(
	server: HttpServerConfig,
): Promise<Record<string, string>> {
	const headers: Record<string, string> = {
		Accept: 'application/json, text/event-stream',
		...(server.headers ?? {}),
	}

	if (server.auth.kind === 'bearer') {
		headers.Authorization = await resolveBearerHeader(server.url, server.auth)
	}

	return headers
}
