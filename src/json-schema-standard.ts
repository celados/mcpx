import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@celados/argc'

import type { JsonSchema } from './types'

type StandardSchema = StandardSchemaV1<
	Record<string, unknown>,
	Record<string, unknown>
> &
	StandardJSONSchemaV1<Record<string, unknown>, Record<string, unknown>>

export type StandardSchemaOptions = {
	/**
	 * Called when input misses a field the cached schema requires: returns the
	 * server's current schema to judge the input by instead, or `undefined` to
	 * keep the cached verdict. A stale cache must not reject a valid call.
	 */
	resync?: () => Promise<unknown>
}

export function jsonSchemaToStandardSchema(
	schema: unknown,
	options: StandardSchemaOptions = {},
): StandardSchema {
	const inputSchema = normalizeInputSchema(schema)

	return {
		'~standard': {
			version: 1,
			vendor: 'mcpx',
			validate: async (value: unknown) => {
				const result = validateObjectInput(value, inputSchema)
				if (!result.issues || !options.resync || !isObject(value)) return result
				const current = await options.resync()
				return current === undefined
					? result
					: validateObjectInput(value, normalizeInputSchema(current))
			},
			jsonSchema: {
				input: () => inputSchema,
				// MCP tool ingress and handler-facing input are the same contract here.
				output: () => inputSchema,
			},
		},
	}
}

function normalizeInputSchema(schema: unknown): JsonSchema {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
		return { type: 'object', properties: {}, additionalProperties: true }
	}

	const record = schema as JsonSchema
	if (
		record.type === 'object' ||
		record.properties ||
		record.anyOf ||
		record.oneOf ||
		record.allOf
	) {
		return record
	}

	return { type: 'object', properties: {}, additionalProperties: true }
}

function validateObjectInput(
	value: unknown,
	schema: JsonSchema,
): StandardSchemaV1.Result<Record<string, unknown>> {
	if (!isObject(value)) {
		return {
			issues: [{ message: 'Input must be a JSON object.' }],
		}
	}

	const input = value as Record<string, unknown>
	if (Array.isArray(schema.required)) {
		const issues = schema.required
			.filter(
				(key): key is string => typeof key === 'string' && !(key in input),
			)
			.map((key) => ({
				message: `Missing required field "${key}".`,
				path: [{ key }],
			}))
		if (issues.length > 0) {
			return { issues }
		}
	}

	// MCP servers remain the source of truth for full JSON Schema validation.
	// This adapter exists to expose argc-compatible schemas without pretending
	// every provider's JSON Schema dialect can be locally enforced yet.
	return { value: input }
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}
