import { describe, expect, test } from "vitest";
import { HarnessRegistry } from "../src/main/harnesses/registry";
import type { HarnessAdapter } from "../src/main/harnesses/types";
import type { Conversation } from "../src/shared/contracts";

function adapter(id: string, capabilities: Partial<HarnessAdapter["descriptor"]["capabilities"]> = {}): HarnessAdapter {
  return {
    descriptor: {
      id,
      version: "test-1",
      displayName: id,
      providerCompatibility: [id === "codex-sdk" ? "codex" : "openrouter"],
      models: [{ id: "test/model", label: "Test model" }],
      capabilities: {
        sessionPersistence: true,
        streaming: true,
        steering: "none",
        cancellation: true,
        tools: true,
        mcp: false,
        usage: "estimated",
        computerControl: false,
        multiAgent: false,
        ...capabilities,
      },
    },
    health: async () => ({ ready: true, label: "Ready", source: "test", detail: "Ready" }),
    run: async () => undefined,
    deliverControl: async () => ({ accepted: false, reason: "unsupported" }),
    cleanup: async () => undefined,
  };
}

function conversation(provider: Conversation["provider"], harnessId?: string): Conversation {
  return {
    id: "conversation",
    title: "Harness test",
    provider,
    ...(harnessId ? { harnessId } : {}),
    model: "test/model",
    reasoning: "medium",
    sandboxMode: "workspace-write",
    allowCommands: false,
    projectMode: "project",
    workingDirectory: "/tmp",
    messages: [],
    activities: [],
    selectedAgentIds: [],
    agentRuns: [],
    crewCommunications: [],
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("harness registry", () => {
  test("maps legacy providers to compatibility adapters", () => {
    const registry = new HarnessRegistry([adapter("codex-sdk"), adapter("openrouter-chat")]);
    expect(registry.resolve(conversation("codex")).descriptor.id).toBe("codex-sdk");
    expect(registry.resolve(conversation("openrouter")).descriptor.id).toBe("openrouter-chat");
  });

  test("rejects duplicate IDs without exposing adapter internals", () => {
    expect(() => new HarnessRegistry([adapter("codex-sdk"), adapter("codex-sdk")])).toThrow('Duplicate harness adapter id "codex-sdk"');
  });

  test("rejects unsupported capability combinations before dispatch", () => {
    const registry = new HarnessRegistry([adapter("openrouter-chat")]);
    expect(() => registry.requireCompatible("openrouter-chat", { mcp: true, computerControl: true }))
      .toThrow("openrouter-chat is incompatible: MCP, computer control");
  });
});
