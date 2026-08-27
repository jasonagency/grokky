import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { defaultOpenRouterCredentialCandidates, isUsableOpenRouterKey, parseEnvValue } from "../src/main/credentials";
import { runOpenRouter } from "../src/main/providers/openrouter-provider";
import { McpAuthManager } from "../src/main/tools/mcp-auth";
import { McpClientManager } from "../src/main/tools/mcp-client-manager";
import { ToolGateway } from "../src/main/tools/tool-gateway";
import type { McpServerConfiguration } from "../src/main/capabilities";
import type { ProviderEvent } from "../src/main/providers/types";
import type { AppSettings, Conversation } from "../src/shared/contracts";
import { computerProviderContext } from "./provider-fixtures";

async function credential(): Promise<string> {
  if (isUsableOpenRouterKey(process.env.OPENROUTER_API_KEY)) return process.env.OPENROUTER_API_KEY;
  for (const pathname of defaultOpenRouterCredentialCandidates(homedir())) {
    const key = await readFile(pathname, "utf8").then((source) => parseEnvValue(source, "OPENROUTER_API_KEY")).catch(() => undefined);
    if (isUsableOpenRouterKey(key)) return key;
  }
  throw new Error("No OpenRouter credential found");
}

describe.skipIf(process.env.GROKKY_LIVE_OPENROUTER_MCP !== "1")("live OpenRouter MCP gateway", () => {
  test("calls one approved local MCP tool through a real model loop", async () => {
    const configuration: McpServerConfiguration = {
      id: "fixture", enabled: true, transport: "stdio", command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url))], timeoutMs: 10_000,
    };
    const gateway = new ToolGateway(new McpClientManager(new McpAuthManager()));
    const prepared = await gateway.prepare([configuration]);
    const now = Date.now();
    const conversation: Conversation = {
      id: "openrouter-mcp-live", title: "MCP live", provider: "openrouter", harnessId: "openrouter-chat",
      model: process.env.GROKKY_OPENROUTER_SMOKE_MODEL || "google/gemini-3.1-flash-lite", reasoning: "low",
      sandboxMode: "read-only", allowCommands: false, projectMode: "project", workingDirectory: "/tmp",
      messages: [], activities: [], selectedAgentIds: [], agentRuns: [], crewCommunications: [], status: "running", createdAt: now, updatedAt: now,
    };
    const settings: AppSettings = {
      defaultWorkingDirectory: "/tmp", recentWorkingDirectories: [], openRouterCredentialPath: "", theme: "dark",
      multiAgentEnabled: false, maxAgentThreads: 1, defaultSubagentModel: "", defaultSubagentReasoning: "", interruptAgentMessage: true,
      connectorsEnabled: true, webSearchEnabled: false, mcpToolPolicies: {},
    };
    const computer = computerProviderContext(conversation);
    computer.computerAccess.grants.mcp = "allow";
    const events: ProviderEvent[] = [];
    try {
      await runOpenRouter({
        conversation, settings, agents: [], prompt: "Call the fixture_lookup tool with q set to LIVE. Then reply with exactly MCP LIVE READY and the tool result.",
        signal: new AbortController().signal, apiKey: await credential(), ...computer, mcpTools: prepared.tools,
        executeMcpTool: (name, args, options) => gateway.execute({ configurations: [configuration], name, args, readOnly: options?.readOnly === true, signal: new AbortController().signal, authorize: async () => undefined }),
        onEvent: async (event) => { events.push(event); },
      });
    } finally {
      await gateway.close();
    }
    const final = events.find((event) => event.type === "final");
    expect(final?.type === "final" ? final.text : "").toContain("MCP LIVE READY");
    expect(JSON.stringify(events)).toContain("stdio:LIVE");
  }, 180_000);
});
