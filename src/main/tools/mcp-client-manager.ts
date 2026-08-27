import { createHash } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpToolClassification, McpToolCapability } from "../../shared/contracts";
import type { McpServerConfiguration } from "../capabilities";
import { McpAuthManager } from "./mcp-auth";
import { boundedToolSchema, classifyMcpTool } from "./tool-classification";

export interface McpDiscoveredTool extends McpToolCapability {
  serverId: string;
  originalName: string;
  inputSchema: Record<string, unknown>;
  toolDefinition: Tool;
}

export interface McpClientLike {
  listTools(): Promise<{ tools: Tool[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }, options?: { signal?: AbortSignal; timeout?: number; maxTotalTimeout?: number; toolDefinition?: Tool }): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type McpConnector = (configuration: McpServerConfiguration, auth: McpAuthManager) => Promise<McpClientLike>;

interface Connection {
  fingerprint: string;
  client: McpClientLike;
  tools: Map<string, McpDiscoveredTool>;
}

export interface McpDiscoveryResult {
  serverId: string;
  status: "ready" | "authorization-required" | "error";
  detail?: string;
  tools: McpDiscoveredTool[];
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

function safeHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("MCP URLs containing credentials are blocked");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("Remote MCP servers must use HTTPS; HTTP is allowed only on loopback");
  }
  return url;
}

function fingerprint(configuration: McpServerConfiguration): string {
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

function resultText(result: CallToolResult): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type === "text") parts.push(item.text);
    else if (item.type === "resource_link") parts.push(`Resource: ${item.name} (${item.uri})`);
    else if (item.type === "image") parts.push(`[Image result: ${item.mimeType}, ${item.data.length} encoded bytes]`);
    else if (item.type === "audio") parts.push(`[Audio result: ${item.mimeType}, ${item.data.length} encoded bytes]`);
    else if (item.type === "resource") parts.push(`[Embedded resource result]`);
  }
  if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  const output = parts.join("\n").slice(0, 40_000);
  if (result.isError) throw new Error("MCP tool reported an error");
  return output || "MCP tool completed without text output.";
}

export async function connectMcpClient(configuration: McpServerConfiguration, auth: McpAuthManager): Promise<McpClientLike> {
  const client = new Client({ name: "grokky", version: "0.1.2" }, { enforceStrictCapabilities: true, listMaxPages: 16 });
  try {
    if (configuration.transport === "stdio") {
      if (!configuration.command) throw new Error("MCP stdio command is missing");
      const transport = new StdioClientTransport({
        command: configuration.command,
        args: configuration.args,
        cwd: configuration.cwd,
        env: { ...getDefaultEnvironment(), ...configuration.env },
        stderr: "ignore",
        maxBufferSize: 2 * 1024 * 1024,
      });
      await client.connect(transport, { signal: AbortSignal.timeout(15_000) });
      return client;
    }
    if (!configuration.url) throw new Error("MCP HTTP URL is missing");
    const url = safeHttpUrl(configuration.url);
    const inheritedToken = configuration.bearerTokenEnvVar ? process.env[configuration.bearerTokenEnvVar] : undefined;
    const authProvider = inheritedToken
      ? { token: async () => inheritedToken }
      : await auth.oauthProvider(configuration.id);
    const transport = new StreamableHTTPClientTransport(url, {
      authProvider,
      requestInit: { headers: configuration.headers },
    });
    await client.connect(transport, { signal: AbortSignal.timeout(15_000) });
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

export class McpClientManager {
  private readonly connections = new Map<string, Connection>();
  private readonly connecting = new Map<string, { fingerprint: string; promise: Promise<Connection> }>();

  constructor(
    readonly auth: McpAuthManager,
    private readonly connector: McpConnector = connectMcpClient,
  ) {}

  async discover(
    configurations: McpServerConfiguration[],
    policies: Record<string, McpToolClassification> = {},
  ): Promise<McpDiscoveryResult[]> {
    const enabled = configurations.filter((configuration) => configuration.enabled);
    const enabledIds = new Set(enabled.map((configuration) => configuration.id));
    await Promise.all([...this.connections.keys()].filter((id) => !enabledIds.has(id)).map((id) => this.closeServer(id)));
    return Promise.all(enabled.map(async (configuration): Promise<McpDiscoveryResult> => {
      try {
        const connection = await this.connection(configuration, policies);
        return { serverId: configuration.id, status: "ready", tools: [...connection.tools.values()] };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "MCP connection failed";
        const authorizationRequired = /unauthoriz|authorization|oauth/i.test(detail);
        return { serverId: configuration.id, status: authorizationRequired ? "authorization-required" : "error", detail: detail.slice(0, 500), tools: [] };
      }
    }));
  }

  async call(
    configuration: McpServerConfiguration,
    namespacedName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    policies: Record<string, McpToolClassification> = {},
  ): Promise<string> {
    const connection = await this.connection(configuration, policies);
    const tool = connection.tools.get(namespacedName);
    if (!tool) throw new Error("MCP tool is unavailable or no longer advertised");
    try {
      const result = await connection.client.callTool(
        { name: tool.originalName, arguments: args },
        { signal, timeout: configuration.timeoutMs, maxTotalTimeout: configuration.timeoutMs, toolDefinition: tool.toolDefinition },
      );
      return resultText(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/closed|disconnect|transport/i.test(message)) {
        await this.closeServer(configuration.id);
        throw new Error("MCP server disconnected during the tool call");
      }
      if (/unauthoriz|oauth|authorization/i.test(message)) throw new Error("MCP authorization is required");
      if (/abort|cancel|timeout/i.test(message) || signal.aborted) throw new Error("MCP tool call was cancelled or timed out");
      throw new Error("MCP tool execution failed");
    }
  }

  async close(): Promise<void> {
    await Promise.all([...new Set([...this.connections.keys(), ...this.connecting.keys()])].map((id) => this.closeServer(id)));
  }

  private async connection(
    configuration: McpServerConfiguration,
    policies: Record<string, McpToolClassification>,
  ): Promise<Connection> {
    const stamp = fingerprint(configuration);
    const existing = this.connections.get(configuration.id);
    if (existing?.fingerprint === stamp) {
      for (const tool of existing.tools.values()) {
        const updated = classifyMcpTool(configuration.id, tool.toolDefinition, policies);
        Object.assign(tool, updated);
      }
      return existing;
    }
    const pending = this.connecting.get(configuration.id);
    if (pending?.fingerprint === stamp) {
      const connection = await pending.promise;
      for (const tool of connection.tools.values()) Object.assign(tool, classifyMcpTool(configuration.id, tool.toolDefinition, policies));
      return connection;
    }
    if (pending) {
      await pending.promise.catch(() => undefined);
      if (this.connections.has(configuration.id)) await this.closeServer(configuration.id);
    } else if (existing) {
      await this.closeServer(configuration.id);
    }
    const promise = this.openConnection(configuration, policies, stamp);
    this.connecting.set(configuration.id, { fingerprint: stamp, promise });
    try {
      return await promise;
    } finally {
      if (this.connecting.get(configuration.id)?.promise === promise) this.connecting.delete(configuration.id);
    }
  }

  private async openConnection(
    configuration: McpServerConfiguration,
    policies: Record<string, McpToolClassification>,
    stamp: string,
  ): Promise<Connection> {
    const client = await this.connector(configuration, this.auth);
    try {
      const listed = await client.listTools();
      if (listed.tools.length > 200) throw new Error("MCP server advertises more than 200 tools");
      const tools = new Map<string, McpDiscoveredTool>();
      for (const definition of listed.tools) {
        if (!/^[^\u0000-\u001f]{1,240}$/.test(definition.name)) throw new Error("MCP server advertised an invalid tool name");
        const classified = classifyMcpTool(configuration.id, definition, policies);
        if (tools.has(classified.namespacedName)) throw new Error("MCP tool name collision was detected");
        tools.set(classified.namespacedName, {
          ...classified,
          serverId: configuration.id,
          originalName: definition.name,
          inputSchema: boundedToolSchema(definition.inputSchema),
          toolDefinition: definition,
        });
      }
      const connection = { fingerprint: stamp, client, tools };
      this.connections.set(configuration.id, connection);
      return connection;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async closeServer(serverId: string): Promise<void> {
    await this.connecting.get(serverId)?.promise.catch(() => undefined);
    const connection = this.connections.get(serverId);
    this.connections.delete(serverId);
    await connection?.client.close().catch(() => undefined);
  }
}
