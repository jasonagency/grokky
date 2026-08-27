import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MainController } from "../src/main/controller";
import { ControlPlaneService } from "../src/main/control-plane/control-plane-service";
import { TaskScheduler } from "../src/main/control-plane/scheduler";
import { CodexSdkAdapter } from "../src/main/harnesses/codex-sdk-adapter";
import { HarnessRegistry } from "../src/main/harnesses/registry";
import { StateStore } from "../src/main/state-store";
import { DirectDatabaseClient } from "../src/main/storage/database-client";
import { WorkspaceLeaseManager } from "../src/main/workspaces/workspace-lease-manager";
import { ComputerAccessService } from "../src/main/computer-access";
import { startRunnerServer } from "../src/main/runner-service";
import { AgentHost } from "../src/runner/agent-host";
import { HostStore } from "../src/runner/host-store";
import { HostHarnessRegistry } from "../src/runner/host-harness-registry";
import { SteeringService } from "../src/main/control-plane/steering-service";

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for task dispatch");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("controller task dispatch", () => {
  test("transfers an assigned task to a paired host and settles it from signed events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-remote-dispatch-"));
    const remoteRoot = await mkdtemp(join(tmpdir(), "grokky-remote-worker-"));
    const remotePrompts: string[] = [];
    const runner = await startRunnerServer({
      root: remoteRoot, statePath: join(remoteRoot, "runner.json"), host: "127.0.0.1", port: 0,
      agentHostFactory: (credential, deviceId) => {
        const registry = new HostHarnessRegistry();
        registry.register("codex-sdk", async (job) => { remotePrompts.push((job.payload as { prompt: string }).prompt); return "completed away from the desktop"; });
        return new AgentHost(deviceId, new HostStore(join(remoteRoot, "host.json")), registry, credential);
      },
    });
    const database = new DirectDatabaseClient(join(directory, "control-plane.sqlite3")); await database.initialize();
    const store = new StateStore(join(directory, "state.json"), directory); const state = await store.load();
    const computer = new ComputerAccessService(); await computer.pair(state.computerAccess, runner.endpoint, runner.code); await store.save(state);
    const adapter = new CodexSdkAdapter(async () => { throw new Error("local harness must not run"); });
    adapter.health = async () => ({ ready: true, label: "Ready", source: "test", detail: "Ready" });
    const scheduler = new TaskScheduler(database, { concurrency: 1, leaseDurationMs: 30_000 });
    const controller = new MainController(store, directory, "test", computer, new ControlPlaneService(database), new HarnessRegistry([adapter]), scheduler, new WorkspaceLeaseManager(database, join(directory, "worktrees")));
    try {
      await controller.initialize();
      const source = controller.snapshot().conversations[0]!;
      await controller.createTaskGoal({ id: "remote-goal", title: "Remote", objective: "Run offline", nodes: [{ id: "remote-task", title: "Remote task", description: "Do this on the host", assignment: { harnessId: "codex-sdk", targetHostId: runner.deviceId, workspaceMode: "write", budgetUsd: 2, approvalPolicy: "allow" } }] });
      await waitFor(() => controller.snapshot().taskGraph.tasks[0]?.status === "succeeded");
      expect(remotePrompts).toEqual(["Do this on the host"]);
      expect(controller.snapshot().taskGraph.tasks[0]?.outcome?.summary).toBe("completed away from the desktop");
      expect(controller.snapshot().workspaceState!.leases).toHaveLength(0);
    } finally { await controller.shutdown(); await store.close(); await database.close(); await runner.close(); }
  });

  test("reconciles a host-owned task after the desktop was closed past its local lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-remote-restart-"));
    const remoteRoot = await mkdtemp(join(tmpdir(), "grokky-remote-offline-"));
    let releaseHost!: () => void;
    const hostMayFinish = new Promise<void>((resolve) => { releaseHost = resolve; });
    let agentHost!: AgentHost;
    const runner = await startRunnerServer({
      root: remoteRoot, statePath: join(remoteRoot, "runner.json"), host: "127.0.0.1", port: 0,
      agentHostFactory: (credential, deviceId) => {
        const registry = new HostHarnessRegistry(); registry.register("codex-sdk", async () => { await hostMayFinish; return "finished while Grokky was closed"; });
        agentHost = new AgentHost(deviceId, new HostStore(join(remoteRoot, "host.json")), registry, credential); return agentHost;
      },
    });
    const databasePath = join(directory, "control-plane.sqlite3");
    const statePath = join(directory, "state.json");
    const computer = new ComputerAccessService();
    const database1 = new DirectDatabaseClient(databasePath); await database1.initialize();
    const store1 = new StateStore(statePath, directory); const state = await store1.load(); await computer.pair(state.computerAccess, runner.endpoint, runner.code); await store1.save(state);
    const adapter = new CodexSdkAdapter(async () => { throw new Error("local harness must not run"); }); adapter.health = async () => ({ ready: true, label: "Ready", source: "test", detail: "Ready" });
    const controller1 = new MainController(store1, directory, "test", computer, new ControlPlaneService(database1), new HarnessRegistry([adapter]), new TaskScheduler(database1, { concurrency: 1, leaseDurationMs: 30_000 }), new WorkspaceLeaseManager(database1, join(directory, "worktrees")));
    await controller1.initialize();
    await controller1.createTaskGoal({ id: "offline-goal", title: "Offline", objective: "Keep going", nodes: [{ id: "offline-task", title: "Offline task", assignment: { harnessId: "codex-sdk", targetHostId: runner.deviceId, budgetUsd: 2, approvalPolicy: "allow" } }] });
    await waitFor(() => agentHost.snapshot().jobs[0]?.status === "running");
    await controller1.shutdown(); await store1.close(); await database1.close();

    releaseHost(); await waitFor(() => agentHost.snapshot().jobs[0]?.status === "succeeded");

    const database2 = new DirectDatabaseClient(databasePath); await database2.initialize();
    const store2 = new StateStore(statePath, directory);
    const controller2 = new MainController(store2, directory, "test", computer, new ControlPlaneService(database2), new HarnessRegistry([adapter]), new TaskScheduler(database2, { concurrency: 1, leaseDurationMs: 30_000, now: () => Date.now() + 60_000 }), new WorkspaceLeaseManager(database2, join(directory, "worktrees")));
    try {
      await controller2.initialize();
      await waitFor(() => controller2.snapshot().taskGraph.tasks[0]?.status === "succeeded");
      expect(controller2.snapshot().taskGraph.tasks[0]?.outcome?.summary).toBe("finished while Grokky was closed");
      expect(agentHost.snapshot().jobs).toHaveLength(1);
      const eventIds = (await database2.listEvents()).map((value) => (JSON.parse(value) as { id: string }).id);
      expect(new Set(eventIds).size).toBe(eventIds.length);
    } finally { await controller2.shutdown(); await store2.close(); await database2.close(); await runner.close(); }
  });

  test("delivers an operator approval to a waiting host job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-remote-approval-")); const remoteRoot = await mkdtemp(join(tmpdir(), "grokky-approval-host-")); let agentHost!: AgentHost;
    const runner = await startRunnerServer({ root: remoteRoot, statePath: join(remoteRoot, "runner.json"), host: "127.0.0.1", port: 0, agentHostFactory: (credential, deviceId) => { const registry = new HostHarnessRegistry(); registry.register("codex-sdk", async (_job, context) => { await context.emit("job.approval", { action: "publish" }); return "approved remotely"; }); agentHost = new AgentHost(deviceId, new HostStore(), registry, credential); return agentHost; } });
    const database = new DirectDatabaseClient(join(directory, "control.sqlite3")); await database.initialize(); const store = new StateStore(join(directory, "state.json"), directory); const state = await store.load(); const computer = new ComputerAccessService(); await computer.pair(state.computerAccess, runner.endpoint, runner.code); await store.save(state);
    const adapter = new CodexSdkAdapter(async () => undefined); adapter.health = async () => ({ ready: false, label: "Local unavailable", source: "test", detail: "Only the host is configured" });
    const controller = new MainController(store, directory, "test", computer, new ControlPlaneService(database), new HarnessRegistry([adapter]), new TaskScheduler(database, { concurrency: 1, leaseDurationMs: 30_000 }), new WorkspaceLeaseManager(database, join(directory, "worktrees")), undefined, new SteeringService(database));
    try {
      await controller.initialize(); await controller.createTaskGoal({ id: "approval-goal", title: "Approval", objective: "Approve", nodes: [{ id: "approval-task", title: "Approval task", assignment: { harnessId: "codex-sdk", targetHostId: runner.deviceId, budgetUsd: 1, approvalPolicy: "ask" } }] });
      await waitFor(() => agentHost.snapshot().jobs[0]?.status === "waiting-approval");
      await controller.controlTask("approval-task", { type: "approve", idempotencyKey: "approve-once" });
      await waitFor(() => controller.snapshot().taskGraph.tasks[0]?.status === "succeeded");
      expect(controller.snapshot().controlRuntime?.commands.at(-1)).toMatchObject({ type: "approve", status: "acknowledged" });
    } finally { await controller.shutdown(); await store.close(); await database.close(); await runner.close(); }
  });

  test("executes ready nodes through the assigned harness and unlocks dependencies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-task-dispatch-"));
    const database = new DirectDatabaseClient(join(directory, "control-plane.sqlite3"));
    await database.initialize();
    const prompts: string[] = [];
    const adapter = new CodexSdkAdapter(async (run) => {
      prompts.push(run.prompt);
      await run.onEvent({ type: "thread", threadId: `session-${prompts.length}` });
      await run.onEvent({ type: "final", text: `Completed node ${prompts.length}` });
    });
    adapter.health = async () => ({ ready: true, label: "Ready", source: "test", detail: "Ready" });
    const scheduler = new TaskScheduler(database, { concurrency: 1, leaseDurationMs: 30_000 });
    const workspaces = new WorkspaceLeaseManager(database, join(directory, "worktrees"));
    const store = new StateStore(join(directory, "state.json"), directory);
    const controller = new MainController(
      store,
      directory,
      "test",
      undefined,
      new ControlPlaneService(database),
      new HarnessRegistry([adapter]),
      scheduler,
      workspaces,
    );

    try {
      await controller.initialize();
      const source = controller.snapshot().conversations[0]!;
      await controller.updateConversation(source.id, { workingDirectory: directory, projectMode: "project" });
      await controller.createTaskGoal({
        id: "delivery",
        title: "Delivery",
        objective: "Run the graph",
        nodes: [
          { id: "research", title: "Research", description: "Map the repository", assignment: { harnessId: "codex-sdk", workspaceMode: "read" } },
          { id: "report", title: "Report", description: "Write the report", dependsOn: ["research"], assignment: { harnessId: "codex-sdk", workspaceMode: "read" } },
        ],
      });

      await waitFor(() => controller.snapshot().taskGraph.goals[0]?.status === "succeeded");

      expect(prompts).toEqual(["Map the repository", "Write the report"]);
      expect(controller.snapshot().taskGraph.tasks).toEqual([
        expect.objectContaining({ id: "research", status: "succeeded", outcome: expect.objectContaining({ summary: "Completed node 1" }) }),
        expect.objectContaining({ id: "report", status: "succeeded", outcome: expect.objectContaining({ summary: "Completed node 2" }) }),
      ]);
      expect(controller.snapshot().workspaceState!.leases).toHaveLength(2);
      expect(controller.snapshot().workspaceState!.leases.every((lease) => lease.status === "completed")).toBe(true);
      const events = (await database.listEvents()).map((value) => JSON.parse(value) as { taskId?: string; attemptId?: string; type: string });
      expect(events.filter((event) => event.type === "run.completed")).toEqual([
        expect.objectContaining({ taskId: "research", attemptId: expect.any(String) }),
        expect.objectContaining({ taskId: "report", attemptId: expect.any(String) }),
      ]);
    } finally {
      await controller.shutdown();
      await store.close();
      await database.close();
    }
  });
});
