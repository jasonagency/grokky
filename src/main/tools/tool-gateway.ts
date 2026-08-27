import type { McpToolClassification } from "../../shared/contracts";
import type { HarnessMcpTool } from "../providers/types";
import type { McpServerConfiguration } from "../capabilities";
import { McpClientManager, type McpDiscoveryResult } from "./mcp-client-manager";

export interface PreparedMcpGateway {
  tools: HarnessMcpTool[];
  results: McpDiscoveryResult[];
}

export class ToolGateway {
  private prepared: PreparedMcpGateway = { tools: [], results: [] };
  constructor(readonly clients: McpClientManager) {}

  async prepare(
    configurations: McpServerConfiguration[],
    policies: Record<string, McpToolClassification> = {},
  ): Promise<PreparedMcpGateway> {
    const results = await this.clients.discover(configurations, policies);
    const tools = results.flatMap((result) => result.tools.map((tool): HarnessMcpTool => ({
      serverId: tool.serverId,
      originalName: tool.originalName,
      name: tool.namespacedName,
      description: `${tool.description} MCP policy: ${tool.classification}.`,
      parameters: tool.inputSchema,
      classification: tool.classification,
      classificationSource: tool.classificationSource,
    })));
    this.prepared = { tools, results };
    return this.prepared;
  }

  cached(): PreparedMcpGateway {
    return this.prepared;
  }

  async execute(options: {
    configurations: McpServerConfiguration[];
    policies?: Record<string, McpToolClassification>;
    name: string;
    args: Record<string, unknown>;
    readOnly: boolean;
    signal: AbortSignal;
    authorize(tool: HarnessMcpTool): Promise<void>;
  }): Promise<string> {
    const prepared = await this.prepare(options.configurations, options.policies);
    const tool = prepared.tools.find((candidate) => candidate.name === options.name);
    if (!tool) throw new Error("MCP tool is not available through the gateway");
    if (tool.classification === "human-only") throw new Error("This MCP tool is restricted to direct human use");
    if (options.readOnly && tool.classification !== "read") throw new Error("Read-only specialists may only call MCP tools classified as read-only");
    const configuration = options.configurations.find((candidate) => candidate.id === tool.serverId && candidate.enabled);
    if (!configuration) throw new Error("MCP server is disabled or no longer configured");
    await options.authorize(tool);
    return this.clients.call(configuration, tool.name, options.args, options.signal, options.policies);
  }

  close(): Promise<void> {
    return this.clients.close();
  }
}
