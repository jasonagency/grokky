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

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for task dispatch");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("controller task dispatch", () => {
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
