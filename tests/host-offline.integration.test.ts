import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { HostClient, type HostTransport } from "../src/main/remote/host-client";
import { HostReconciler } from "../src/main/remote/host-reconciler";
import { RemoteStateRepository } from "../src/main/storage/repositories/remote-state-repository";
import { AgentHost } from "../src/runner/agent-host";
import { HostHarnessRegistry } from "../src/runner/host-harness-registry";
import { createHostHarnessRegistry } from "../src/runner/host-harness-adapters";
import { HostStore } from "../src/runner/host-store";
import { HarnessRegistry } from "../src/main/harnesses/registry";
import type { HarnessAdapter } from "../src/main/harnesses/types";
import { resolve } from "node:path";
import { ScreenSessionManager, type ScreenProvider } from "../src/runner/screen-session-manager";

function transport(host: AgentHost): HostTransport { return { capabilities: async () => host.capabilities(), submit: (credential, request) => host.submit(credential, request), events: async (credential, cursor, limit) => host.events(credential, cursor, limit), control: (credential, command) => host.control(credential, command) }; }
async function eventually(check: () => boolean): Promise<void> { for (let index = 0; index < 100; index += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error("condition not reached"); }

describe("offline remote host", () => {
  test("runs a real PuckBot harness adapter with host-local bounded tools", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-host-adapter-"));
    const adapter: HarnessAdapter = {
      descriptor: {
        id: "test-adapter", version: "1", displayName: "Test adapter", providerCompatibility: ["pi"], models: [{ id: "test/model", label: "Test" }],
        capabilities: { sessionPersistence: true, streaming: true, steering: "mid-turn", cancellation: true, tools: true, mcp: false, usage: "authoritative", computerControl: true, multiAgent: false },
      },
      health: async () => ({ ready: true, label: "Ready", source: "test", detail: "Ready" }),
      run: async (context) => {
        await context.executeTool("create_file", { path: "remote-result.txt", content: context.prompt });
        await context.executeTool("capture_screen", {});
        await context.executeTool("click_screen", { x: 4, y: 8 });
        await context.onEvent({ type: "thread", threadId: "remote-session" });
        await context.onEvent({ type: "final", text: "remote adapter finished" });
      },
      deliverControl: async () => ({ accepted: true }),
      cleanup: async () => undefined,
    };
    const provider: ScreenProvider = { kind: "browser", create: async () => ({ sessionId: "remote-page", delivery: "snapshot" }), capture: async () => ({ mediaType: "image/png", data: "screen-frame" }), input: async () => undefined, close: async () => undefined };
    const screens = new ScreenSessionManager([provider]);
    const registry = await createHostHarnessRegistry({
      homeDirectory: directory,
      root: directory,
      harnessRegistry: new HarnessRegistry([adapter]),
      allowWrite: true,
      allowCommands: false,
      screens,
    });
    const host = new AgentHost("host", new HostStore(), registry, "secret", () => 10, screens); await host.initialize();

    await host.submit("secret", {
      id: "job", idempotencyKey: "job-once", taskId: "task", attemptId: "attempt", leaseEpoch: 1,
      harnessId: "test-adapter", approvalPolicy: "allow", budgetUsd: 1,
      payload: { prompt: "written by the remote harness", model: "test/model", reasoning: "medium", sandboxMode: "workspace-write", allowCommands: false },
    });

    await eventually(() => host.snapshot().jobs[0]?.status === "succeeded");
    expect(await readFile(join(directory, "remote-result.txt"), "utf8")).toBe("written by the remote harness");
    expect(host.snapshot().events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "job.output", payload: expect.objectContaining({ event: expect.objectContaining({ type: "thread", threadId: "remote-session" }) }) }),
      expect.objectContaining({ type: "job.output", payload: expect.objectContaining({ event: expect.objectContaining({ type: "activity", activity: expect.objectContaining({ label: "Screen screenshot", detail: "Captured frame 1" }) }) }) }),
      expect.objectContaining({ type: "job.completed", payload: { output: "remote adapter finished" } }),
    ]));
  });

  test("routes host-configured MCP through the PuckBot gateway", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-host-mcp-"));
    await mkdir(join(directory, ".codex"));
    await writeFile(join(directory, ".codex", "config.toml"), `[mcp_servers.fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(resolve("tests/fixtures/mcp-stdio-server.mjs"))}]\nenabled = true\n`);
    const adapter: HarnessAdapter = {
      descriptor: { id: "openrouter-test", version: "1", displayName: "OpenRouter test", providerCompatibility: ["openrouter"], models: [{ id: "test/model", label: "Test" }], capabilities: { sessionPersistence: false, streaming: true, steering: "none", cancellation: true, tools: true, mcp: true, usage: "authoritative", computerControl: true, multiAgent: false } },
      health: async () => ({ ready: true, label: "Ready", source: "test", detail: "Ready" }),
      run: async (context) => { const tool = context.mcpTools?.[0]; if (!tool || !context.executeMcpTool) throw new Error("Host MCP was not prepared"); const result = await context.executeMcpTool(tool.name, { q: "remote" }); await context.onEvent({ type: "final", text: result }); },
      deliverControl: async () => ({ accepted: false }), cleanup: async () => undefined,
    };
    const registry = await createHostHarnessRegistry({ homeDirectory: directory, root: directory, harnessRegistry: new HarnessRegistry([adapter]), allowWrite: false, allowCommands: false });
    const host = new AgentHost("host", new HostStore(), registry, "secret"); await host.initialize();
    try {
      await host.submit("secret", { id: "mcp-job", idempotencyKey: "mcp-once", taskId: "mcp-task", attemptId: "mcp-attempt", leaseEpoch: 1, harnessId: "openrouter-test", approvalPolicy: "allow", budgetUsd: 1, payload: { prompt: "Use MCP", model: "test/model", reasoning: "low", sandboxMode: "read-only", allowCommands: false } });
      await eventually(() => host.snapshot().jobs[0]?.status === "succeeded");
      expect(JSON.stringify(host.snapshot().events.find((event) => event.type === "job.completed")?.payload)).toContain("stdio:remote");
    } finally { await host.shutdown(); }
  });

  test("continues to approval while desktop is disconnected and reconciles after approval", async () => {
    const registry = new HostHarnessRegistry(); registry.register("fixture", async (_job, context) => { await context.emit("job.output", { stage: "offline-work" }); await context.emit("job.approval", { action: "publish" }); return "published"; });
    const host = new AgentHost("host", new HostStore(), registry, "secret", () => 10); await host.initialize();
    const client = new HostClient("http://127.0.0.1:4747", "secret", transport(host)); await client.connect();
    await client.submit({ id: "job", idempotencyKey: "routine:occurrence", taskId: "routine-task", attemptId: "attempt", leaseEpoch: 4, harnessId: "fixture", payload: {}, approvalPolicy: "ask", budgetUsd: 2 });
    await eventually(() => host.snapshot().jobs[0]?.status === "waiting-approval");
    const database = { value: null as string | null, readRemoteState: async () => database.value, writeRemoteState: async (next: string) => { database.value = next; } };
    const reconciler = new HostReconciler(new RemoteStateRepository(database), client); await reconciler.initialize();
    expect((await reconciler.reconcile()).accepted).toBe(4);
    await client.control({ id: "approve", jobId: "job", leaseEpoch: 4, afterCursor: reconciler.snapshot().acknowledgedCursor, type: "approve", decision: "allow" });
    await eventually(() => host.snapshot().jobs[0]?.status === "succeeded");
    expect((await reconciler.reconcile()).accepted).toBe(1);
    expect(reconciler.snapshot().events.at(-1)?.type).toBe("job.completed");
    host.revoke();
    await expect(client.submit({ id: "next", idempotencyKey: "next", taskId: "task", attemptId: "attempt", leaseEpoch: 1, harnessId: "fixture", payload: {}, approvalPolicy: "ask", budgetUsd: 1 })).rejects.toThrow("authorization");
    expect(host.snapshot().jobs[0]?.status).toBe("succeeded");
  });

  test("starts a registered routine graph after its fire time with no desktop connected", async () => {
    let now = 10; const order: string[] = [];
    const registry = new HostHarnessRegistry(); registry.register("fixture", async (job, context) => { order.push((job.payload as { node: string }).node); if ((job.payload as { approval?: boolean }).approval) await context.emit("job.approval", { action: "publish" }); return `done:${(job.payload as { node: string }).node}`; });
    const host = new AgentHost("host", new HostStore(), registry, "secret", () => now); await host.initialize();
    await host.upsertRoutine("secret", {
      id: "routine:offline", version: 1, enabled: true, nextFireAt: 100, schedule: { localTime: "00:00", timeZone: "UTC" },
      nodes: [
        { id: "research", dependsOn: [], harnessId: "fixture", payload: { node: "research" }, approvalPolicy: "allow", budgetUsd: 1 },
        { id: "publish", dependsOn: ["research"], harnessId: "fixture", payload: { node: "publish", approval: true }, approvalPolicy: "ask", budgetUsd: 1 },
      ],
    });
    expect(host.snapshot().jobs).toHaveLength(0);

    now = 100; await host.runDueRoutines();
    await eventually(() => host.snapshot().jobs.some((job) => job.status === "waiting-approval"));
    expect(order).toEqual(["research", "publish"]);
    const publish = host.snapshot().jobs.find((job) => job.payload && (job.payload as { node?: string }).node === "publish")!;
    const client = new HostClient("http://127.0.0.1:4747", "secret", transport(host)); await client.connect();
    const beforeReconnect = host.snapshot().events.length;
    await client.control({ id: "routine-approve", jobId: publish.id, leaseEpoch: publish.leaseEpoch, afterCursor: 0, type: "approve", decision: "allow" });
    await eventually(() => host.snapshot().jobs.every((job) => job.status === "succeeded"));
    expect((await client.events(0)).length).toBeGreaterThan(beforeReconnect);
    await host.runDueRoutines();
    expect(host.snapshot().jobs).toHaveLength(2);
  });

  test("host restart marks an unrecoverable active harness interrupted and retains its spool", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-host-restart-"));
    const pathname = join(directory, "host.json");
    const firstStore = new HostStore(pathname); await firstStore.initialize();
    await firstStore.mutate((state) => { state.jobs.push({ id: "job", idempotencyKey: "once", taskId: "task", attemptId: "attempt", leaseEpoch: 1, harnessId: "fixture", payload: {}, approvalPolicy: "ask", budgetUsd: 1, status: "running", createdAt: 1, updatedAt: 1 }); });
    const registry = new HostHarnessRegistry(); registry.register("fixture", async () => "done");
    const restarted = new AgentHost("host", new HostStore(pathname), registry, "secret", () => 20); await restarted.initialize();
    await eventually(() => restarted.snapshot().jobs[0]?.status === "interrupted");
    expect(restarted.snapshot().jobs[0]).toMatchObject({ status: "interrupted", error: "Host restarted while the harness was running" });
    await eventually(() => restarted.snapshot().events.some((event) => event.type === "job.failed"));
  });

  test("host restart interrupts an approval wait whose in-memory continuation was lost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-host-approval-restart-")); const pathname = join(directory, "host.json");
    const store = new HostStore(pathname); await store.initialize();
    await store.mutate((state) => { state.jobs.push({ id: "job", idempotencyKey: "once", taskId: "task", attemptId: "attempt", leaseEpoch: 1, harnessId: "fixture", payload: {}, approvalPolicy: "ask", budgetUsd: 1, status: "waiting-approval", createdAt: 1, updatedAt: 1 }); });
    const registry = new HostHarnessRegistry(); registry.register("fixture", async () => "done");
    const restarted = new AgentHost("host", new HostStore(pathname), registry, "secret", () => 20); await restarted.initialize();
    await eventually(() => restarted.snapshot().jobs[0]?.status === "interrupted");
    expect(restarted.snapshot().jobs[0]?.error).toContain("waiting for approval");
    await eventually(() => restarted.snapshot().events.some((event) => event.type === "job.failed"));
  });
});
