// The 401 challenge, not this declaration, decides whether a server needs OAuth;
// `none` is promoted to `oauth` once a Call is challenged and authorized.
export type AuthDiscovery =
	| { kind: 'none' }
	| { kind: 'oauth' }
	| {
			kind: 'bearer'
			credentials: BearerCredential[]
			strategy: 'round-robin'
			confidence: 'configured'
	  }

export type BearerCredential =
	| { kind: 'env'; name: string }
	| { kind: 'literal'; value: string }

export type ToolDefinition = {
	name: string
	commandName: string
	title?: string
	description?: string
	inputSchema?: JsonSchema
	annotations?: ToolAnnotations
	_meta?: Record<string, unknown>
}

export type HttpServerConfig = {
	transport?: 'http'
	url: string
	headers?: Record<string, string>
	auth: AuthDiscovery
	discoveredAt?: string
	tools?: ToolDefinition[]
	refreshStatus?: ServerRefreshStatus
}

export type StdioServerConfig = {
	transport: 'stdio'
	command: string
	args?: string[]
	env?: Record<string, string>
	cwd?: string
	discoveredAt?: string
	tools?: ToolDefinition[]
	refreshStatus?: ServerRefreshStatus
}

export type ServerConfig = HttpServerConfig | StdioServerConfig

export type ServerRefreshStatus = {
	checkedAt: string
	status: 'ok' | 'reauth-required' | 'unreachable'
	message?: string
}

export type RegistryConfig = {
	version: 1
	servers: Record<string, ServerConfig>
}

export type JsonSchema = Record<string, unknown>

export type DiscoveryResult = {
	server: ServerConfig
	status: 'ready' | 'auth-required' | 'unreachable'
	message?: string
}

export type McpTool = {
	name: string
	title?: string
	description?: string
	inputSchema?: unknown
	annotations?: ToolAnnotations
	_meta?: Record<string, unknown>
}

export type ToolAnnotations = {
	title?: string
	readOnlyHint?: boolean
	destructiveHint?: boolean
	idempotentHint?: boolean
	openWorldHint?: boolean
}
