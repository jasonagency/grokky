import { describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSdkAdapter } from "../src/main/harnesses/codex-sdk-adapter";
import { OpenRouterAdapter } from "../src/main/harnesses/openrouter-adapter";
import { HarnessRegistry } from "../src/main/harnesses/registry";
import type { ProviderRunContext } from "../src/main/providers/types";
import type { Conversation } from "../src/shared/contracts";
import { MainController } from "../src/main/controller";
import { StateStore } from "../src/main/state-store";
import { DirectDatabaseClient } from "../src/main/storage/database-client";
import { ControlPlaneService } from "../src/main/control-plane/control-plane-service";

function context(provider: Conversation["provider"], onEvent: ProviderRunContext["onEvent"]): ProviderRunContext {
  return {
    conversation: {
      id: "conversation",
      title: "Compatibility",
      provider,
      model: provider === "codex" ? "gpt-5.6-sol" : "openai/gpt-5.2",
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
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    },
    settings: {
      defaultWorkingDirectory: "/tmp",
      recentWorkingDirectories: [],
      openRouterCredentialPath: "",
      theme: "system",
      multiAgentEnabled: true,
      maxAgentThreads: 4,
      defaultSubagentModel: "",
      defaultSubagentReasoning: "",
      interruptAgentMessage: true,
      connectorsEnabled: true,
      webSearchEnabled: true,
    },
    agents: [],
    prompt: "Test",
    signal: new AbortController().signal,
    computerAccess: {
      enabled: false,
      localDeviceId: "local-test-device",
      activeDeviceId: "local-test-device",
      grants: { files: "blocked", commands: "blocked", browser: "blocked", screen: "blocked", automation: "blocked", mcp: "blocked" },
      networkAllowlist: [],
      remoteDevices: [],
      auditLog: [],
    },
    executeTool: async () => "",
    onEvent,
  };
}

describe("compatibility harnesses", () => {
  test.each([
    ["codex", () => new CodexSdkAdapter(async (run) => { await run.onEvent({ type: "final", text: "Done" }); await run.onEvent({ type: "usage", usage: { inputTokens: 2, outputTokens: 1 } }); })],
    ["openrouter", () => new OpenRouterAdapter("/tmp", async (run) => { await run.onEvent({ type: "final", text: "Done" }); await run.onEvent({ type: "usage", usage: { inputTokens: 2, outputTokens: 1 } }); }, async () => ({ apiKey: "test-key", source: "test" }))],
  ] as const)("preserves one final and aggregated usage for %s", async (provider, createAdapter) => {
    const events: unknown[] = [];
    const adapter = createAdapter();
    const registry = new HarnessRegistry([adapter]);
    const run = context(provider, (event) => { events.push(event); });

    await registry.dispatch(run.conversation, run);

    expect(events.filter((event) => (event as { type?: string }).type === "final")).toHaveLength(1);
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 2, outputTokens: 1 } });
  });

  test("cancellation reaches the adapter and records one terminal attempt event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-harness-cancel-"));
    let cancellationReached = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const adapter = new CodexSdkAdapter(async (run) => new Promise<void>((_resolve, reject) => {
      markStarted();
      const cancel = () => {
        cancellationReached = true;
        reject(new Error("aborted"));
      };
      if (run.signal.aborted) cancel();
      else run.signal.addEventListener("abort", cancel, { once: true });
    }));
    adapter.health = async () => ({ ready: true, label: "Ready", source: "test", detail: "Ready" });
    const registry = new HarnessRegistry([adapter]);
    const eventDatabase = new DirectDatabaseClient(join(directory, "events.sqlite3"));
    await eventDatabase.initialize();
    const store = new StateStore(join(directory, "state.json"), directory);
    const controller = new MainController(store, directory, "test", undefined, new ControlPlaneService(eventDatabase), registry);
    await controller.initialize();
    const conversationId = controller.snapshot().conversations[0]!.id;

    await controller.sendMessage(conversationId, "Say hello");
    await started;
    await controller.cancelRun(conversationId);
    await Promise.resolve();

    const attempt = controller.snapshot().conversations[0]!.harnessAttempts;
    const events = (await eventDatabase.listEvents()).map((value) => JSON.parse(value) as { type: string });
    expect(cancellationReached).toBe(true);
    expect(attempt).toEqual([expect.objectContaining({ harnessId: "codex-sdk", adapterVersion: "compat-1", status: "stopped" })]);
    expect(events.filter((event) => event.type === "run.stopped")).toHaveLength(1);
    await store.close();
    await eventDatabase.close();
  });
});
