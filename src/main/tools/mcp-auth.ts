import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  auth,
  discoverOAuthServerInfo,
  type FetchLike,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";

export interface McpSecretAdapter {
  seal(value: string): string;
  unseal(value: string): string;
}

interface OAuthRecord {
  state?: string;
  verifier?: string;
  authorizationUrl?: string;
  authorizationServerUrl?: string;
  resourceUrl?: string;
  discovery?: OAuthDiscoveryState;
  latestIssuer?: string;
  tokens: Record<string, StoredOAuthTokens>;
  clients: Record<string, StoredOAuthClientInformation>;
}

type PersistedAuth = { version: 1; entries: Record<string, string> };

function emptyRecord(): OAuthRecord {
  return { tokens: {}, clients: {} };
}

function requireServerId(value: string): string {
  if (!/^[a-zA-Z0-9_@./-]{1,240}$/.test(value) || new Set(["__proto__", "constructor", "prototype"]).has(value)) throw new Error("Invalid MCP server ID");
  return value;
}

function secureEndpoint(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("MCP OAuth endpoint must use HTTPS or loopback HTTP");
  return url.toString();
}

function callbackParts(value: string): { code: string; state?: string; iss?: string } {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Authorization code is required");
  if (!/^https?:\/\//i.test(trimmed)) return { code: trimmed };
  const url = new URL(trimmed);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("Authorization callback does not contain a code");
  return { code, state: url.searchParams.get("state") ?? undefined, iss: url.searchParams.get("iss") ?? undefined };
}

class StoredOAuthProvider implements OAuthClientProvider {
  private record: OAuthRecord = emptyRecord();

  constructor(
    readonly serverId: string,
    private readonly persist: (record: OAuthRecord) => Promise<void>,
    private readonly loadRecord: () => Promise<OAuthRecord>,
    private readonly callbackUrl = "http://127.0.0.1:4793/oauth/callback",
  ) {}

  async load(): Promise<void> { this.record = await this.loadRecord(); }
  get redirectUrl(): string { return this.callbackUrl; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "PuckBot MCP Gateway",
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  async state(): Promise<string> {
    if (!this.record.state) {
      this.record.state = randomBytes(24).toString("base64url");
      await this.persist(this.record);
    }
    return this.record.state;
  }
  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    return this.record.clients[ctx?.issuer ?? this.record.latestIssuer ?? ""];
  }
  async saveClientInformation(value: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): Promise<void> {
    const issuer = ctx?.issuer || value.issuer || "default";
    this.record.clients[issuer] = value;
    this.record.latestIssuer = issuer;
    await this.persist(this.record);
  }
  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    return this.record.tokens[ctx?.issuer ?? this.record.latestIssuer ?? ""];
  }
  async saveTokens(value: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    const issuer = ctx?.issuer || value.issuer || this.record.latestIssuer || "default";
    this.record.tokens[issuer] = value;
    this.record.latestIssuer = issuer;
    await this.persist(this.record);
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    this.record.authorizationUrl = url.toString();
    await this.persist(this.record);
  }
  async saveCodeVerifier(value: string): Promise<void> { this.record.verifier = value; await this.persist(this.record); }
  codeVerifier(): string {
    if (!this.record.verifier) throw new Error("MCP authorization verifier is unavailable");
    return this.record.verifier;
  }
  async saveAuthorizationServerUrl(value: string): Promise<void> { this.record.authorizationServerUrl = value; await this.persist(this.record); }
  authorizationServerUrl(): string | undefined { return this.record.authorizationServerUrl; }
  async saveResourceUrl(value: string): Promise<void> { this.record.resourceUrl = value; await this.persist(this.record); }
  resourceUrl(): string | undefined { return this.record.resourceUrl; }
  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> { this.record.discovery = value; await this.persist(this.record); }
  discoveryState(): OAuthDiscoveryState | undefined { return this.record.discovery; }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "client") this.record.clients = {};
    if (scope === "all" || scope === "tokens") this.record.tokens = {};
    if (scope === "all" || scope === "verifier") {
      this.record.verifier = undefined;
      this.record.state = undefined;
      this.record.authorizationUrl = undefined;
    }
    if (scope === "all" || scope === "discovery") this.record.discovery = undefined;
    if (scope === "all") {
      this.record.latestIssuer = undefined;
      this.record.authorizationUrl = undefined;
      this.record.authorizationServerUrl = undefined;
      this.record.resourceUrl = undefined;
      this.record.state = undefined;
    }
    await this.persist(this.record);
  }
  authorizationUrl(): string | undefined { return this.record.authorizationUrl; }
  expectedState(): string | undefined { return this.record.state; }
  latestTokens(): StoredOAuthTokens | undefined { return this.tokens(); }
  latestClient(): StoredOAuthClientInformation | undefined { return this.clientInformation(); }
}

export class McpAuthManager {
  private readonly providers = new Map<string, StoredOAuthProvider>();
  private memory: PersistedAuth = { version: 1, entries: {} };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly pathname?: string,
    private readonly secrets?: McpSecretAdapter,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  async oauthProvider(serverId: string): Promise<OAuthClientProvider> {
    return this.provider(requireServerId(serverId));
  }

  async begin(serverId: string, serverUrl: string): Promise<string> {
    const provider = await this.provider(serverId);
    await provider.invalidateCredentials("verifier");
    const result = await auth(provider, { serverUrl, fetchFn: this.fetchFn });
    if (result === "AUTHORIZED") return "authorized";
    const url = provider.authorizationUrl();
    if (!url) throw new Error("MCP authorization server did not provide a redirect URL");
    return url;
  }

  async complete(serverId: string, serverUrl: string, callback: string): Promise<void> {
    const provider = await this.provider(serverId);
    const parts = callbackParts(callback);
    if (!provider.expectedState() || parts.state !== provider.expectedState()) throw new Error("MCP authorization state did not match; paste the complete callback URL");
    const result = await auth(provider, { serverUrl, authorizationCode: parts.code, iss: parts.iss, fetchFn: this.fetchFn });
    if (result !== "AUTHORIZED") throw new Error("MCP authorization did not complete");
  }

  async revoke(serverId: string, serverUrl: string): Promise<void> {
    const provider = await this.provider(serverId);
    const tokens = provider.latestTokens();
    try {
      if (tokens?.access_token || tokens?.refresh_token) {
        const info = await discoverOAuthServerInfo(serverUrl, { fetchFn: this.fetchFn });
        const endpoint = (info.authorizationServerMetadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
        if (endpoint) {
          const client = provider.latestClient();
          for (const [token, hint] of [[tokens.access_token, "access_token"], [tokens.refresh_token, "refresh_token"]] as const) {
            if (!token) continue;
            const body = new URLSearchParams({ token, token_type_hint: hint });
            if (client?.client_id) body.set("client_id", client.client_id);
            const response = await this.fetchFn(secureEndpoint(endpoint), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
            if (!response.ok) throw new Error(`MCP token revocation failed (${response.status})`);
          }
        }
      }
    } finally {
      await provider.invalidateCredentials("all");
    }
  }

  private async provider(serverId: string): Promise<StoredOAuthProvider> {
    await this.load();
    let provider = this.providers.get(serverId);
    if (!provider) {
      provider = new StoredOAuthProvider(
        serverId,
        async (record) => this.saveRecord(serverId, record),
        async () => this.readRecord(serverId),
      );
      await provider.load();
      this.providers.set(serverId, provider);
    }
    return provider;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.pathname || !this.secrets) return;
    try {
      const parsed = JSON.parse(await readFile(this.pathname, "utf8")) as PersistedAuth;
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") this.memory = parsed;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  private readRecord(serverId: string): OAuthRecord {
    const sealed = this.memory.entries[serverId];
    if (!sealed || !this.secrets) return emptyRecord();
    const parsed = JSON.parse(this.secrets.unseal(sealed)) as OAuthRecord;
    return { ...emptyRecord(), ...parsed, tokens: parsed.tokens ?? {}, clients: parsed.clients ?? {} };
  }

  private async saveRecord(serverId: string, record: OAuthRecord): Promise<void> {
    if (!this.pathname || !this.secrets) return;
    this.memory.entries[serverId] = this.secrets.seal(JSON.stringify(record));
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.pathname!), { recursive: true });
      const temporary = `${this.pathname}.next`;
      await writeFile(temporary, JSON.stringify(this.memory), { mode: 0o600 });
      await rename(temporary, this.pathname!);
    });
    await this.writeQueue;
  }
}
