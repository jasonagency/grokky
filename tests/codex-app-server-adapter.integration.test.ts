import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { CodexAppServerAdapter } from "../src/main/harnesses/codex-app-server-adapter";
import type { HarnessAdapter } from "../src/main/harnesses/types";
import type { ProviderEvent, ProviderRunContext } from "../src/main/providers/types";
import type { AppSettings, Conversation } from "../src/shared/contracts";
import { computerProviderContext } from "./provider-fixtures";

class FakeClient {
  requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  notifications: Array<(method: string, params: unknown) => void | Promise<void>> = [];
  requestHandler?: (method: string, params: unknown) => unknown | Promise<unknown>;
  fatal?: (error: Error) => void;
  threadId = "thread-1";
  turnId = "turn-1";
  async initialize() {}
  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params: params as Record<string, unknown> });
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: this.threadId } } as T;
    if (method === "turn/start") {
      queueMicrotask(() => void this.emit("turn/completed", { threadId: this.threadId, turn: { id: this.turnId, status: "completed" } }));
      return { turn: { id: this.turnId } } as T;
    }
    return {} as T;
  }
  onNotification(listener: (method: string, params: unknown) => void | Promise<void>) { this.notifications.push(listener); return () => undefined; }
  onRequest(listener: (method: string, params: unknown) => unknown | Promise<unknown>) { this.requestHandler = listener; }
  onFatal(listener: (error: Error) => void) { this.fatal = listener; return () => undefined; }
  async close() {}
  async emit(method: string, params: unknown) { for (const listener of this.notifications) await listener(method, params); }
}

const fallback: HarnessAdapter = {
  descriptor: { id: "codex-sdk", version: "test", displayName: "SDK", providerCompatibility: ["codex"], models: [], capabilities: { sessionPersistence: true, streaming: true, steering: "none", cancellation: true, tools: true, mcp: true, usage: "authoritative", computerControl: true, multiAgent: true } },
  health: async () => ({ ready: true, label: "Ready", source: "test", detail: "ready" }),
  run: vi.fn(async () => undefined), deliverControl: async () => ({ accepted: false }), cleanup: async () => undefined,
};

function context(events: ProviderEvent[], threadId?: string): ProviderRunContext {
  const now = Date.now();
  const conversation: Conversation = {
    id: "conversation", title: "Codex", provider: "codex", harnessId: "codex-app-server",
    model: "gpt-5.6-luna", reasoning: "low", sandboxMode: "read-only", allowCommands: false,
    projectMode: "project", workingDirectory: "/tmp", ...(threadId ? { threadId } : {}), messages: [],
    activities: [], selectedAgentIds: [], agentRuns: [], crewCommunications: [], status: "running", createdAt: now, updatedAt: now,
  };
  const settings: AppSettings = { defaultWorkingDirectory: "/tmp", recentWorkingDirectories: ["/tmp"], openRouterCredentialPath: "", theme: "dark", multiAgentEnabled: false, maxAgentThreads: 1, defaultSubagentModel: "", defaultSubagentReasoning: "", interruptAgentMessage: true, connectorsEnabled: false, webSearchEnabled: false };
  return {
    conversation, settings, agents: [], prompt: "hello", signal: new AbortController().signal,
    ...computerProviderContext(conversation),
    onEvent: async (event) => { events.push(event); },
  };
}

describe("Codex App Server adapter", () => {
  test("starts and resumes the same native session", async () => {
    for (const existing of [undefined, "thread-1"]) {
      const client = new FakeClient();
      const events: ProviderEvent[] = [];
      await new CodexAppServerAdapter(async () => client, fallback).run(context(events, existing));
      expect(client.requests[0]?.method).toBe(existing ? "thread/resume" : "thread/start");
      expect(JSON.stringify(client.requests.find((entry) => entry.method === "turn/start")?.params.input))
        .toContain("requested_model=gpt-5.6-luna");
      expect(events).toContainEqual({ type: "thread", threadId: "thread-1" });
    }
  });

  test("steers only the expected active turn, queues follow-up, and interrupts once", async () => {
    const client = new FakeClient();
    let finish!: () => void;
    client.request = async function<T>(method: string, params: unknown): Promise<T> {
      this.requests.push({ method, params: params as Record<string, unknown> });
      if (method === "thread/start") return { thread: { id: this.threadId } } as T;
      if (method === "turn/start") return { turn: { id: this.turnId } } as T;
      if (method === "turn/interrupt") finish();
      return {} as T;
    };
    const adapter = new CodexAppServerAdapter(async () => client, fallback);
    const running = adapter.run(context([]));
    await vi.waitFor(() => expect(client.requests.some((entry) => entry.method === "turn/start")).toBe(true));
    expect(await adapter.deliverControl({ type: "steer", message: "new", turnId: "stale" })).toMatchObject({ accepted: false, reason: expect.stringContaining("Stale") });
    expect((await adapter.deliverControl({ type: "steer", message: "new", turnId: "turn-1" })).accepted).toBe(true);
    expect((await adapter.deliverControl({ type: "follow-up", message: "later" })).accepted).toBe(true);
    const interrupted = new Promise<void>((resolve) => { finish = () => { void client.emit("turn/completed", { turn: { id: "turn-1", status: "interrupted" } }).then(resolve); }; });
    expect((await adapter.deliverControl({ type: "cancel", turnId: "turn-1" })).accepted).toBe(true);
    await interrupted;
    await running;
    expect(client.requests.filter((entry) => entry.method === "turn/interrupt")).toHaveLength(1);
  });

  test("redacts approval arguments and applies PuckBot policy", async () => {
    const client = new FakeClient();
    const events: ProviderEvent[] = [];
    const running = new CodexAppServerAdapter(async () => client, fallback).run(context(events));
    await vi.waitFor(() => expect(client.requestHandler).toBeTypeOf("function"));
    const response = await client.requestHandler!("item/commandExecution/requestApproval", { itemId: "approval", command: "secret --token abc", reason: "Needs command access" });
    expect(response).toEqual({ decision: "decline" });
    expect(JSON.stringify(events)).not.toContain("secret --token");
    await running;
  });

  test("records and uses SDK fallback when App Server cannot initialize", async () => {
    const events: ProviderEvent[] = [];
    const run = vi.fn(async () => undefined);
    await new CodexAppServerAdapter(async () => { throw new Error("unsupported protocol"); }, { ...fallback, run }).run(context(events));
    expect(run).toHaveBeenCalledOnce();
    expect(JSON.stringify(events)).toContain("fallback selected");
  });
});

describe.skipIf(process.env.GROKKY_LIVE_CODEX_APP_SERVER !== "1")("live Codex App Server adapter", () => {
  test("starts a native session and steers its active turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-app-server-live-"));
    const events: ProviderEvent[] = [];
    const liveContext = context(events);
    liveContext.conversation = { ...liveContext.conversation, workingDirectory: directory, sandboxMode: "workspace-write", allowCommands: true };
    liveContext.prompt = "Run the shell command sleep 5. Then answer with exactly ORIGINAL PHRASE.";
    const adapter = new CodexAppServerAdapter();
    const running = adapter.run(liveContext);
    let steering = await adapter.deliverControl({ type: "steer", message: "Answer with exactly STEERED PHRASE instead." });
    for (let attempt = 0; !steering.accepted && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      steering = await adapter.deliverControl({ type: "steer", message: "Answer with exactly STEERED PHRASE instead." });
    }
    expect(steering).toEqual({ accepted: true });
    await running;
    const finals = events.filter((event): event is Extract<ProviderEvent, { type: "final" }> => event.type === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toContain("STEERED PHRASE");
    const sessionId = events.find((event): event is Extract<ProviderEvent, { type: "thread" }> => event.type === "thread")?.threadId;
    expect(sessionId).toBeTruthy();
    const resumedEvents: ProviderEvent[] = [];
    const resumed = context(resumedEvents, sessionId);
    resumed.conversation = { ...resumed.conversation, workingDirectory: directory };
    resumed.prompt = "Answer with exactly RESUMED PHRASE.";
    await adapter.run(resumed);
    expect(resumedEvents).toContainEqual({ type: "thread", threadId: sessionId });
    expect(resumedEvents.filter((event): event is Extract<ProviderEvent, { type: "final" }> => event.type === "final").at(-1)?.text).toContain("RESUMED PHRASE");
  }, 180_000);
});
