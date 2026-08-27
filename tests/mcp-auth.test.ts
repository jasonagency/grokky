import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import { McpAuthManager } from "../src/main/tools/mcp-auth";

const secrets = {
  seal: (value: string) => Buffer.from(`sealed:${value}`, "utf8").toString("base64"),
  unseal: (value: string) => Buffer.from(value, "base64").toString("utf8").replace(/^sealed:/, ""),
};

describe("MCP OAuth storage", () => {
  test("persists tokens sealed and restores them by authorization-server issuer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-mcp-auth-"));
    const pathname = join(directory, "auth.json");
    const first = new McpAuthManager(pathname, secrets);
    const provider = await first.oauthProvider("docs") as OAuthClientProvider;
    await provider.saveTokens({ access_token: "super-secret-token", token_type: "Bearer", issuer: "https://auth.example" }, { issuer: "https://auth.example" });
    const raw = await readFile(pathname, "utf8");
    expect(raw).not.toContain("super-secret-token");

    const restored = await new McpAuthManager(pathname, secrets).oauthProvider("docs");
    expect((await restored.tokens({ issuer: "https://auth.example" }))?.access_token).toBe("super-secret-token");
  });

  test("rejects an OAuth callback whose state differs from the PKCE session", async () => {
    const manager = new McpAuthManager();
    const provider = await manager.oauthProvider("docs");
    const state = await provider.state?.();
    expect(state).toBeTruthy();
    await expect(manager.complete("docs", "https://mcp.example/mcp", "https://app.example/callback?code=x&state=wrong")).rejects.toThrow("state did not match");
  });

  test("runs PKCE, resource-indicator exchange, refresh fallback, and revocation", async () => {
    let access = 0;
    let failRefresh = false;
    const requests: Array<{ url: string; body: string }> = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
      requests.push({ url, body });
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
      if (url.includes("oauth-protected-resource")) return json({ resource: "https://mcp.example/mcp", authorization_servers: ["https://auth.example"], scopes_supported: ["mcp.read"] });
      if (url.includes(".well-known")) return json({
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        registration_endpoint: "https://auth.example/register",
        revocation_endpoint: "https://auth.example/revoke",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp.read", "offline_access"],
      });
      if (url.endsWith("/register")) return json({
        client_id: "grokky-test",
        redirect_uris: ["http://127.0.0.1:4793/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }, 201);
      if (url.endsWith("/token")) {
        if (body.includes("grant_type=refresh_token") && failRefresh) return json({ error: "invalid_grant" }, 400);
        access += 1;
        return json({ access_token: `access-${access}`, refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600 });
      }
      if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
      throw new Error(`Unexpected OAuth URL: ${url}`);
    };
    const manager = new McpAuthManager(undefined, undefined, fakeFetch);
    const authorizationUrl = await manager.begin("remote", "https://mcp.example/mcp");
    const parsed = new URL(authorizationUrl);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("resource")).toBe("https://mcp.example/mcp");
    const state = parsed.searchParams.get("state")!;
    await manager.complete("remote", "https://mcp.example/mcp", `https://app.example/callback?code=valid&state=${state}`);
    expect((await (await manager.oauthProvider("remote")).tokens())?.access_token).toBe("access-1");
    await expect(manager.begin("remote", "https://mcp.example/mcp")).resolves.toBe("authorized");
    expect((await (await manager.oauthProvider("remote")).tokens())?.access_token).toBe("access-2");

    await manager.revoke("remote", "https://mcp.example/mcp");
    expect(await (await manager.oauthProvider("remote")).tokens()).toBeUndefined();
    expect(requests.some((request) => request.url.endsWith("/revoke") && request.body.includes("token="))).toBe(true);

    await (await manager.oauthProvider("remote")).saveTokens({ access_token: "access-3", refresh_token: "refresh-bad", token_type: "Bearer", issuer: "https://auth.example" }, { issuer: "https://auth.example" });
    failRefresh = true;
    const reconnectUrl = await manager.begin("remote", "https://mcp.example/mcp");
    expect(reconnectUrl).toContain("/authorize?");
    expect(await (await manager.oauthProvider("remote")).tokens()).toBeUndefined();
  });
});
