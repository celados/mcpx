import type { HttpServerConfig } from './types'

import { resolveBearerHeader, resolveBearerHeaderForProbe } from './bearer'

export type ResolvedHeaders = {
	headers: Record<string, string>
	authRefreshed: boolean
}

export function resolveProbeHeaders(
	server: HttpServerConfig,
): Record<string, string> {
	const headers = baseHeaders(server)

	if (server.auth.kind === 'bearer') {
		headers.Authorization = resolveBearerHeaderForProbe(server.auth)
	}

	return headers
}

export async function resolveHeaders(
	server: HttpServerConfig,
): Promise<Record<string, string>> {
	return (await resolveHeadersWithState(server)).headers
}

export async function resolveHeadersWithState(
	server: HttpServerConfig,
): Promise<ResolvedHeaders> {
	const headers = baseHeaders(server)

	if (server.auth.kind === 'bearer') {
		headers.Authorization = await resolveBearerHeader(server.url, server.auth)
	}

	return { headers, authRefreshed: false }
}

function baseHeaders(server: HttpServerConfig): Record<string, string> {
	return {
		Accept: 'application/json, text/event-stream',
		...(server.headers ?? {}),
	}
}

export function normalizeAuthScheme(tokenType: string): string {
	const normalized = tokenType.toLowerCase()
	return normalized === 'bearer' ||
		normalized === 'bot' ||
		normalized === 'user'
		? 'Bearer'
		: tokenType
}
