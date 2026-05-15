export type AuthDiscovery =
  | { kind: "none" }
  | {
      kind: "oauth";
      confidence: "confirmed" | "inferred";
      resourceMetadataUrl?: string;
      authorizationServers?: string[];
      scopesSupported?: string[];
    }
  | { kind: "bearer"; source: "env"; env: string; confidence: "configured" }
  | { kind: "oauth-token"; tokenKey: string; confidence: "confirmed" }
  | { kind: "unknown"; reason: string };

export type OAuthServerMetadata = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
};

export type OAuthToken = {
  accessToken: string;
  tokenType: string;
  clientId?: string;
  clientSecretKey?: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
};

export type TokenCache = {
  version: 1;
  oauth: Record<string, OAuthToken>;
  oauthClientSecrets?: Record<string, string>;
};

export type ToolDefinition = {
  name: string;
  commandName: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};

export type ServerConfig = {
  url: string;
  headers?: Record<string, string>;
  auth: AuthDiscovery;
  discoveredAt?: string;
  tools?: ToolDefinition[];
  refreshStatus?: ServerRefreshStatus;
};

export type ServerRefreshStatus = {
  checkedAt: string;
  status: "ok" | "reauth-required" | "unreachable";
  message?: string;
};

export type RegistryConfig = {
  version: 1;
  servers: Record<string, ServerConfig>;
};

export type JsonSchema = Record<string, unknown>;

export type DiscoveryResult = {
  server: ServerConfig;
  status: "ready" | "auth-required" | "unreachable";
  message?: string;
};

export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};

export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};
