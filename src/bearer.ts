import { createHash } from 'node:crypto'

import type { AuthDiscovery, BearerCredential } from './types'

export function authFromBearerValues(
	values: string | string[] | undefined,
): AuthDiscovery | undefined {
	if (values === undefined) return undefined
	const rawValues = Array.isArray(values) ? values : [values]
	const credentials = rawValues.map(parseBearerCredential)
	if (credentials.length === 0) return undefined
	return {
		kind: 'bearer',
		credentials,
		strategy: 'round-robin',
		confidence: 'configured',
	}
}

export function bearerAuthRef(
	auth: Extract<AuthDiscovery, { kind: 'bearer' }>,
): string[] {
	return auth.credentials.map((credential) => {
		if (credential.kind === 'env') return `env:${credential.name}`
		return `literal:${hashSecret(credential.value)}`
	})
}

export function describeBearerAuth(
	auth: Extract<AuthDiscovery, { kind: 'bearer' }>,
): string {
	return `bearer ${bearerAuthRef(auth).join(',')}`
}

export function resolveBearerHeaderForProbe(
	auth: Extract<AuthDiscovery, { kind: 'bearer' }>,
): string {
	const credential = auth.credentials[0]
	if (!credential)
		throw new Error('Bearer auth requires at least one credential.')
	return normalizeBearerToken(resolveBearerCredential(credential))
}

export async function resolveBearerHeader(
	_serverUrl: string,
	auth: Extract<AuthDiscovery, { kind: 'bearer' }>,
): Promise<string> {
	// Runtime call activation owns round-robin; discovery only probes one identity.
	return resolveBearerHeaderForProbe(auth)
}

function parseBearerCredential(value: string): BearerCredential {
	const trimmed = value.trim()
	if (!trimmed) throw new Error('Bearer credential cannot be empty.')
	const envName = parseEnvReference(trimmed)
	if (envName) return { kind: 'env', name: envName }
	return { kind: 'literal', value: trimmed }
}

function parseEnvReference(value: string): string | undefined {
	if (value.startsWith('env:')) {
		const name = value.slice('env:'.length)
		if (!isEnvName(name))
			throw new Error(`Invalid bearer env reference: ${value}`)
		return name
	}

	const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
	return match?.[1]
}

function resolveBearerCredential(credential: BearerCredential): string {
	if (credential.kind === 'literal') return credential.value
	const value = process.env[credential.name]
	if (!value)
		throw new Error(`Bearer env reference "${credential.name}" is not set.`)
	return value
}

function normalizeBearerToken(value: string): string {
	return value.startsWith('Bearer ') ? value : `Bearer ${value}`
}

function hashSecret(value: string): string {
	return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function isEnvName(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}
