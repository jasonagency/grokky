import { describe, expect, test, vi, beforeEach } from "vitest";
import type { AgentDefinition, AppSettings, Conversation } from "../src/shared/contracts";
import type { ProviderEvent } from "../src/main/providers/types";
import { computerProviderContext } from "./provider-fixtures";

const sdk = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@openrouter/sdk", () => ({
  OpenRouter: class {
    chat = { send: sdk.send };
  },
}));

import { runOpenRouter } from "../src/main/providers/openrouter-provider";

function fixture(selectedAgentIds: string[] = []) {
  const now = Date.now();
  const conversation: Conversation = {
    id: "openrouter-mcp", title: "MCP", provider: "openrouter", harnessId: "openrouter-chat", model: "fixture/model", reasoning: "low",
    sandboxMode: "workspace-write", allowCommands: false, projectMode: "project", workingDirectory: "/tmp",
    messages: [], activities: [], selectedAgentIds, agentRuns: [], crewCommunications: [], status: "running", createdAt: now, updatedAt: now,
  };
  const settings: AppSettings = {
    defaultWorkingDirectory: "/tmp", recentWorkingDirectories: [], openRouterCredentialPath: "", theme: "dark",
    multiAgentEnabled: true, maxAgentThreads: 2, defaultSubagentModel: "", defaultSubagentReasoning: "", interruptAgentMessage: true,
    connectorsEnabled: true, webSearchEnabled: false, mcpToolPolicies: {},
  };
  const computer = computerProviderContext(conversation);
  computer.computerAccess.grants.mcp = "allow";
  return { conversation, settings, computer };
}

describe("OpenRouter MCP integration", () => {
  beforeEach(() => sdk.send.mockReset());

  test("advertises namespaced MCP definitions and routes calls through the gateway", async () => {
    sdk.send
      .mockResolvedValueOnce({ choices: [{ message: { content: "", toolCalls: [{ id: "call-1", type: "function", function: { name: "mcp_docs_search_abcd1234", arguments: "{\"q\":\"MCP\"}" } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "Gateway result accepted." } }] });
    const { conversation, settings, computer } = fixture();
    const events: ProviderEvent[] = [];
    const executeMcpTool = vi.fn(async () => "official MCP result");
    const mcpParameters = {
      type: "object",
      properties: { q: { type: "string" }, limit: { type: "integer" } },
      required: ["q"],
      additionalProperties: false,
    };
    await runOpenRouter({
      conversation, settings, agents: [], prompt: "Research MCP", signal: new AbortController().signal, apiKey: "test",
      ...computer,
      mcpTools: [{
        serverId: "docs",
        originalName: "search",
        name: "mcp_docs_search_abcd1234",
        description: "Search docs",
        parameters: mcpParameters,
        classification: "read",
        classificationSource: "operator",
      }],
      executeMcpTool,
      onEvent: async (event) => { events.push(event); },
    });
    const request = sdk.send.mock.calls[0]![0].chatRequest;
    expect(request.tools).toEqual(expect.arrayContaining([expect.objectContaining({
      function: expect.objectContaining({
        name: "mcp_docs_search_abcd1234",
        strict: false,
        parameters: mcpParameters,
      }),
    })]));
    expect(request.tools).toEqual(expect.arrayContaining([expect.objectContaining({
      function: expect.objectContaining({ name: "list_files", strict: true }),
    })]));
    expect(JSON.stringify(request)).not.toContain("OPENROUTER_API_KEY");
    expect(executeMcpTool).toHaveBeenCalledWith("mcp_docs_search_abcd1234", { q: "MCP" }, { readOnly: false });
    expect(events.filter((event) => event.type === "final")).toEqual([{ type: "final", text: "Gateway result accepted." }]);
    expect(events.some((event) => event.type === "activity" && event.activity.status === "completed" && event.activity.detail === "official MCP result")).toBe(true);
  });

  test("read-only crew sees only read-classified MCP tools while lead sees side effects", async () => {
    sdk.send
      .mockResolvedValueOnce({ choices: [{ message: { content: "Crew findings" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "Lead answer" } }] });
    const { conversation, settings, computer } = fixture(["researcher"]);
    const agents: AgentDefinition[] = [{ id: "researcher", name: "Researcher", description: "Research", developerInstructions: "Read only", scope: "project", builtIn: false }];
    await runOpenRouter({
      conversation, settings, agents, prompt: "Research", signal: new AbortController().signal, apiKey: "test", ...computer,
      mcpTools: [
        { serverId: "docs", originalName: "search", name: "mcp_docs_search_1", description: "Search", parameters: { type: "object" }, classification: "read", classificationSource: "operator" },
        { serverId: "crm", originalName: "send", name: "mcp_crm_send_2", description: "Send", parameters: { type: "object" }, classification: "external-side-effect", classificationSource: "safe-default" },
      ],
      executeMcpTool: vi.fn(), onEvent: vi.fn(),
    });
    const crewNames = sdk.send.mock.calls[0]![0].chatRequest.tools.map((tool: { function: { name: string } }) => tool.function.name);
    const leadNames = sdk.send.mock.calls[1]![0].chatRequest.tools.map((tool: { function: { name: string } }) => tool.function.name);
    expect(crewNames).toContain("mcp_docs_search_1");
    expect(crewNames).not.toContain("mcp_crm_send_2");
    expect(leadNames).toEqual(expect.arrayContaining(["mcp_docs_search_1", "mcp_crm_send_2"]));
  });
});
