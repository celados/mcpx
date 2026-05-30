import { describe, expect, it } from "bun:test";

import {
  chooseOAuthScope,
  fetchAuthorizationServerMetadata,
  parseOAuthTokenResponse,
  shouldRefreshOAuthToken,
} from "../src/oauth";

describe("oauth", () => {
  it("uses protected-resource scopes that are supported by the authorization server", () => {
    expect(chooseOAuthScope(["openid", "profile", "alert:read"], ["openid", "alert:read"])).toBe(
      "openid alert:read",
    );
  });

  it("discovers authorization server metadata for path-based issuers", async () => {
    const requestedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      requestedUrls.push(url);
      if (url !== "https://supabase.example/.well-known/oauth-authorization-server/auth/v1") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({
        issuer: "https://supabase.example/auth/v1",
        authorization_endpoint: "https://supabase.example/auth/v1/oauth/authorize",
        token_endpoint: "https://supabase.example/auth/v1/oauth/token",
      });
    }) as typeof fetch;

    try {
      const metadata = await fetchAuthorizationServerMetadata("https://supabase.example/auth/v1");

      expect(requestedUrls).toEqual([
        "https://supabase.example/.well-known/oauth-authorization-server/auth/v1",
      ]);
      expect(metadata.issuer).toBe("https://supabase.example/auth/v1");
      expect(metadata.authorizationEndpoint).toBe(
        "https://supabase.example/auth/v1/oauth/authorize",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to issuer-relative metadata used by some hosted OAuth providers", async () => {
    const requestedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      requestedUrls.push(url);
      if (url !== "https://supabase.example/auth/v1/.well-known/oauth-authorization-server") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({
        issuer: "https://supabase.example/auth/v1",
        authorization_endpoint: "https://supabase.example/auth/v1/oauth/authorize",
        token_endpoint: "https://supabase.example/auth/v1/oauth/token",
      });
    }) as typeof fetch;

    try {
      const metadata = await fetchAuthorizationServerMetadata("https://supabase.example/auth/v1");

      expect(requestedUrls).toEqual([
        "https://supabase.example/.well-known/oauth-authorization-server/auth/v1",
        "https://supabase.example/auth/v1/.well-known/oauth-authorization-server",
      ]);
      expect(metadata.tokenEndpoint).toBe("https://supabase.example/auth/v1/oauth/token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refreshes oauth tokens one minute before expiry", () => {
    const now = new Date("2026-04-27T08:00:00.000Z");

    expect(
      shouldRefreshOAuthToken(
        {
          accessToken: "access",
          tokenType: "Bearer",
          expiresAt: "2026-04-27T08:00:59.000Z",
        },
        now,
      ),
    ).toBe(true);
    expect(
      shouldRefreshOAuthToken(
        {
          accessToken: "access",
          tokenType: "Bearer",
          expiresAt: "2026-04-27T08:01:01.000Z",
        },
        now,
      ),
    ).toBe(false);
  });

  it("uses Slack authed_user token payloads", () => {
    expect(
      parseOAuthTokenResponse(
        {
          ok: true,
          access_token: "xoxb-bot",
          token_type: "bot",
          authed_user: {
            access_token: "xoxp-user",
            refresh_token: "refresh-user",
            token_type: "user",
            scope: "search:read.users",
            expires_in: 3600,
          },
        },
        {
          clientId: "client-id",
          clientSecretKey: "oauth-client:client-id",
        },
      ),
    ).toMatchObject({
      accessToken: "xoxp-user",
      clientId: "client-id",
      clientSecretKey: "oauth-client:client-id",
      refreshToken: "refresh-user",
      tokenType: "user",
      scope: "search:read.users",
    });
  });
});
