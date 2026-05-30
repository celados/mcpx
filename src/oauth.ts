import { createHash, randomBytes } from "node:crypto";

import { cancel, confirm, isCancel, note, password, text } from "@clack/prompts";

import { getOAuthClientSecret, putOAuthTokenWithClientSecret } from "./token-cache";
import type { AuthDiscovery, OAuthServerMetadata, OAuthToken } from "./types";

type OAuthClientRegistration = {
  clientId: string;
  clientSecret?: string;
  clientSecretKey?: string;
};

type OAuthCallbackResult = {
  code: string;
  state: string;
};

type OAuthCallbackServer = {
  redirectUri: string;
  result: Promise<OAuthCallbackResult>;
  close: () => void;
};

type AuthenticatedOAuth = Extract<AuthDiscovery, { kind: "oauth-token" }>;
type DiscoveredOAuth = Extract<AuthDiscovery, { kind: "oauth" }>;

const LOCALHOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
// Manual OAuth clients require a pre-registered redirect URI; random ports break that contract.
const MANUAL_CALLBACK_PORT = 65245;

export async function authenticateOAuthServer(
  serverName: string,
  resourceUrl: URL,
  auth: DiscoveredOAuth,
): Promise<AuthenticatedOAuth> {
  const authorizationServer = auth.authorizationServers?.[0];
  if (!authorizationServer) {
    throw new Error("OAuth authentication requires an authorization server URL.");
  }

  const metadata = await fetchAuthorizationServerMetadata(authorizationServer);
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(24));
  const manualClient = metadata.registrationEndpoint
    ? undefined
    : await promptForManualOAuthClient(serverName, metadata, auth);
  const callback = await waitForOAuthCallback(state, manualClient ? MANUAL_CALLBACK_PORT : 0);

  try {
    const client = manualClient ?? (await registerOAuthClient(metadata, callback.redirectUri));
    const scope = chooseOAuthScope(auth.scopesSupported, metadata.scopesSupported);
    const authorizationUrl = buildAuthorizationUrl({
      metadata,
      clientId: client.clientId,
      redirectUri: callback.redirectUri,
      resourceUrl: resourceUrl.toString(),
      scope,
      state,
      challenge,
    });

    console.error(`Opening browser for OAuth authentication: ${authorizationUrl}`);
    openBrowser(authorizationUrl);

    const callbackResult = await callback.result;
    const exchangeOptions: {
      metadata: OAuthServerMetadata;
      clientId: string;
      clientSecret?: string;
      redirectUri: string;
      resourceUrl: string;
      code: string;
      verifier: string;
    } = {
      metadata,
      clientId: client.clientId,
      redirectUri: callback.redirectUri,
      resourceUrl: resourceUrl.toString(),
      code: callbackResult.code,
      verifier,
    };
    if (client.clientSecret) exchangeOptions.clientSecret = client.clientSecret;
    const token = await exchangeAuthorizationCode(exchangeOptions);

    const tokenKey = `${serverName}:${metadata.issuer}`;
    await putOAuthTokenWithClientSecret(tokenKey, token, client.clientSecret);
    return { kind: "oauth-token", tokenKey, confidence: "confirmed" };
  } finally {
    callback.close();
  }
}

export async function fetchAuthorizationServerMetadata(
  issuer: string,
): Promise<OAuthServerMetadata> {
  const metadataUrls = authorizationServerMetadataUrls(issuer);
  const failures: string[] = [];

  for (const metadataUrl of metadataUrls) {
    const response = await fetch(metadataUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      failures.push(`${metadataUrl} (${response.status})`);
      continue;
    }

    return parseAuthorizationServerMetadata(await response.json(), metadataUrl.toString(), issuer);
  }

  throw new Error(`Failed to fetch OAuth server metadata from ${failures.join(", ")}.`);
}

function authorizationServerMetadataUrls(issuer: string): URL[] {
  const issuerUrl = new URL(issuer);
  const issuerPath = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname;
  const urls = [
    // RFC 8414 inserts the well-known path between host and issuer path.
    new URL(`/.well-known/oauth-authorization-server${issuerPath}`, issuerUrl.origin),
  ];

  const issuerRelativePath = `${issuerPath.replace(/\/?$/, "/")}.well-known/oauth-authorization-server`;
  const issuerRelativeUrl = new URL(issuerRelativePath, issuerUrl.origin);
  if (!urls.some((url) => url.toString() === issuerRelativeUrl.toString())) {
    urls.push(issuerRelativeUrl);
  }
  return urls;
}

function parseAuthorizationServerMetadata(
  payload: unknown,
  metadataUrl: string,
  issuer: string,
): OAuthServerMetadata {
  const metadata = payload as Record<string, unknown>;
  const authorizationEndpoint = stringField(metadata.authorization_endpoint);
  const tokenEndpoint = stringField(metadata.token_endpoint);
  const issuerValue = stringField(metadata.issuer) ?? issuer;
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error(`OAuth server metadata at ${metadataUrl} is missing required endpoints.`);
  }

  const result: OAuthServerMetadata = {
    issuer: issuerValue,
    authorizationEndpoint,
    tokenEndpoint,
  };
  const registrationEndpoint = stringField(metadata.registration_endpoint);
  if (registrationEndpoint) result.registrationEndpoint = registrationEndpoint;
  const scopesSupported = stringArray(metadata.scopes_supported);
  if (scopesSupported) result.scopesSupported = scopesSupported;
  const methods = stringArray(metadata.code_challenge_methods_supported);
  if (methods) result.codeChallengeMethodsSupported = methods;
  const authMethods = stringArray(metadata.token_endpoint_auth_methods_supported);
  if (authMethods) result.tokenEndpointAuthMethodsSupported = authMethods;
  return result;
}

export async function registerOAuthClient(
  metadata: OAuthServerMetadata,
  redirectUri: string,
): Promise<OAuthClientRegistration> {
  if (!metadata.registrationEndpoint) {
    throw new Error("OAuth server does not advertise dynamic client registration.");
  }

  const response = await fetch(metadata.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "MCPX",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });

  if (!response.ok) {
    throw new Error(`OAuth dynamic client registration failed: ${await response.text()}`);
  }

  const body = (await response.json()) as Record<string, unknown>;
  const clientId = stringField(body.client_id);
  if (!clientId) {
    throw new Error("OAuth dynamic client registration response did not include client_id.");
  }
  return { clientId };
}

export function chooseOAuthScope(
  resourceScopes: string[] | undefined,
  serverScopes: string[] | undefined,
): string {
  const supported = new Set(serverScopes ?? []);
  const scopes = (resourceScopes ?? []).filter((scope) => {
    return supported.size === 0 || supported.has(scope);
  });
  return scopes.join(" ");
}

export function shouldRefreshOAuthToken(token: OAuthToken, now: Date = new Date()): boolean {
  if (!token.expiresAt) return false;
  const expiresAt = Date.parse(token.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - now.getTime() <= 60_000;
}

export async function refreshOAuthToken(options: {
  issuer: string;
  resourceUrl: string;
  token: OAuthToken;
}): Promise<OAuthToken> {
  if (!options.token.refreshToken) {
    throw new Error("OAuth token is expired and has no refresh token. Run mcpx @add again.");
  }
  if (!options.token.clientId) {
    throw new Error(
      "OAuth token is expired and cannot be refreshed because it was created by an older mcpx version. Run mcpx @add again.",
    );
  }
  const metadata = await fetchAuthorizationServerMetadata(options.issuer);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: options.token.clientId,
    refresh_token: options.token.refreshToken,
    resource: options.resourceUrl,
  });
  const clientSecret = options.token.clientSecretKey
    ? await getOAuthClientSecret(options.token.clientSecretKey)
    : undefined;
  if (options.token.clientSecretKey && !clientSecret) {
    throw new Error("OAuth client secret is missing. Run mcpx @add again.");
  }
  if (clientSecret) body.set("client_secret", clientSecret);

  const response = await fetch(metadata.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`OAuth token refresh failed: ${await response.text()}`);
  }

  const fallback: {
    clientId: string;
    clientSecretKey?: string;
    refreshToken: string;
  } = {
    clientId: options.token.clientId,
    refreshToken: options.token.refreshToken,
  };
  if (options.token.clientSecretKey) fallback.clientSecretKey = options.token.clientSecretKey;
  return parseOAuthTokenResponse(await response.json(), fallback);
}

function buildAuthorizationUrl(options: {
  metadata: OAuthServerMetadata;
  clientId: string;
  redirectUri: string;
  resourceUrl: string;
  scope: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(options.metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", options.state);
  url.searchParams.set("resource", options.resourceUrl);
  if (options.scope) url.searchParams.set("scope", options.scope);
  return url.toString();
}

async function exchangeAuthorizationCode(options: {
  metadata: OAuthServerMetadata;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  resourceUrl: string;
  code: string;
  verifier: string;
}): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    code: options.code,
    code_verifier: options.verifier,
    resource: options.resourceUrl,
  });
  if (options.clientSecret) body.set("client_secret", options.clientSecret);

  const response = await fetch(options.metadata.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`OAuth token exchange failed: ${await response.text()}`);
  }

  const fallback: {
    clientId: string;
    clientSecretKey?: string;
  } = {
    clientId: options.clientId,
  };
  if (options.clientSecret) fallback.clientSecretKey = clientSecretKey(options.clientId);
  return parseOAuthTokenResponse(await response.json(), fallback);
}

export function parseOAuthTokenResponse(
  payload: unknown,
  fallback: {
    clientId: string;
    clientSecretKey?: string;
    refreshToken?: string;
  },
): OAuthToken {
  const body = parseSuccessfulTokenPayload(payload);
  const tokenBody = selectTokenBody(body);
  const accessToken = stringField(tokenBody.access_token);
  const tokenType = stringField(tokenBody.token_type) ?? "Bearer";
  if (!accessToken) {
    throw new Error("OAuth token response did not include access_token.");
  }

  const token: OAuthToken = {
    accessToken,
    clientId: fallback.clientId,
    tokenType,
  };
  if (fallback.clientSecretKey) token.clientSecretKey = fallback.clientSecretKey;
  const refreshToken = stringField(tokenBody.refresh_token) ?? fallback.refreshToken;
  if (refreshToken) token.refreshToken = refreshToken;
  const scope = stringField(tokenBody.scope);
  if (scope) token.scope = scope;
  const expiresIn = numberField(tokenBody.expires_in);
  if (expiresIn !== undefined) {
    token.expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  }
  return token;
}

async function promptForManualOAuthClient(
  serverName: string,
  metadata: OAuthServerMetadata,
  auth: DiscoveredOAuth,
): Promise<OAuthClientRegistration> {
  if (!process.stdin.isTTY) {
    throw new Error("Manual OAuth client authentication requires an interactive terminal.");
  }
  if (
    metadata.tokenEndpointAuthMethodsSupported &&
    !metadata.tokenEndpointAuthMethodsSupported.includes("client_secret_post")
  ) {
    throw new Error("OAuth server requires a client authentication method mcpx cannot use yet.");
  }

  const redirectUri = `http://${LOCALHOST}:${MANUAL_CALLBACK_PORT}${CALLBACK_PATH}`;
  note(
    [
      "This OAuth server does not support dynamic client registration.",
      "Before continuing, open the provider app settings, add this exact Redirect URL, and save it.",
      `Redirect URL: ${redirectUri}`,
      'For Slack, this is under "OAuth & Permissions" -> "Redirect URLs".',
      `Authorization server: ${metadata.issuer}`,
      auth.scopesSupported?.length ? `Requested scopes: ${auth.scopesSupported.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    `${serverName} OAuth client`,
  );

  const redirectConfigured = await confirm({
    message: "I have already added and saved this exact Redirect URL in the provider app",
    initialValue: false,
  });
  if (isCancel(redirectConfigured) || !redirectConfigured) {
    cancel("OAuth authentication cancelled.");
    throw new Error(`Add ${redirectUri} as a redirect URL, then run mcpx @add again.`);
  }

  const clientId = await text({
    message: "OAuth client_id",
    validate: (value) => (value && value.trim() ? undefined : "client_id is required."),
  });
  if (isCancel(clientId)) {
    cancel("OAuth authentication cancelled.");
    throw new Error("OAuth authentication cancelled.");
  }

  const clientSecret = await password({
    message: "OAuth client_secret",
    validate: (value) => (value && value.trim() ? undefined : "client_secret is required."),
  });
  if (isCancel(clientSecret)) {
    cancel("OAuth authentication cancelled.");
    throw new Error("OAuth authentication cancelled.");
  }

  return {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    clientSecretKey: clientSecretKey(clientId.trim()),
  };
}

function parseSuccessfulTokenPayload(payload: unknown): Record<string, unknown> {
  const body = payload as Record<string, unknown>;
  if (body.ok === false) {
    throw new Error(`OAuth token response failed: ${stringField(body.error) ?? "unknown_error"}`);
  }
  return body;
}

function selectTokenBody(body: Record<string, unknown>): Record<string, unknown> {
  const authedUser = body.authed_user;
  if (
    authedUser &&
    typeof authedUser === "object" &&
    stringField((authedUser as Record<string, unknown>).access_token)
  ) {
    return authedUser as Record<string, unknown>;
  }
  return body;
}

function clientSecretKey(clientId: string): string {
  return `oauth-client:${clientId}`;
}

function waitForOAuthCallback(expectedState: string, port: number): OAuthCallbackServer {
  let server: Bun.Server<undefined> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const result = new Promise<OAuthCallbackResult>((finish, fail) => {
    const complete = (outcome: "finish" | "fail", value: OAuthCallbackResult | Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server?.stop();
      if (outcome === "finish") {
        finish(value as OAuthCallbackResult);
        return;
      }
      fail(value);
    };

    timer = setTimeout(() => {
      complete("fail", new Error("OAuth authentication timed out."));
    }, CALLBACK_TIMEOUT_MS);

    server = Bun.serve({
      hostname: LOCALHOST,
      port,
      routes: {
        [CALLBACK_PATH]: (request) => {
          const requestUrl = new URL(request.url);
          const code = requestUrl.searchParams.get("code");
          const state = requestUrl.searchParams.get("state");
          const error = requestUrl.searchParams.get("error");
          if (error) {
            complete("fail", new Error(`OAuth authorization failed: ${error}`));
            return new Response(`OAuth failed: ${error}`, { status: 400 });
          }
          if (!code || state !== expectedState) {
            complete("fail", new Error("Invalid OAuth callback."));
            return new Response("Invalid OAuth callback.", { status: 400 });
          }

          complete("finish", { code, state });
          return new Response("MCPX authentication complete. You can close this tab.");
        },
      },
      fetch() {
        return new Response("Not found", { status: 404 });
      },
    });
  });

  if (!server) {
    throw new Error("Failed to start local OAuth callback server.");
  }

  return {
    redirectUri: `http://${LOCALHOST}:${server.port}${CALLBACK_PATH}`,
    result,
    close: () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server?.stop();
    },
  };
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  Bun.spawn([command, ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

function base64Url(input: Buffer): string {
  return input.toString("base64url");
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((entry): entry is string => typeof entry === "string");
  return values.length > 0 ? values : undefined;
}
