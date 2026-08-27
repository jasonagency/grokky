import { describe, expect, test } from "vitest";
import { TaskExecutionPausedError, TaskScheduler, type TaskGraphStore } from "../src/main/control-plane/scheduler";

class MemoryTaskStore implements TaskGraphStore {
  value: string | null = null;
  writes = 0;

  async readTaskGraph(): Promise<string | null> {
    return this.value;
  }

  async writeTaskGraph(snapshot: string): Promise<void> {
    this.value = snapshot;
    this.writes += 1;
  }
}

function scheduler(store = new MemoryTaskStore(), concurrency = 2) {
  let now = 1_000;
  let sequence = 0;
  return {
    store,
    setNow(value: number) { now = value; },
    scheduler: new TaskScheduler(store, {
      concurrency,
      leaseDurationMs: 100,
      now: () => now,
      id: (prefix) => `${prefix}-${++sequence}`,
    }),
  };
}

describe("task scheduler", () => {
  test("leases independent roots up to concurrency and never leases a blocked child", async () => {
    const setup = scheduler();
    await setup.scheduler.initialize();
    await setup.scheduler.createGoal({
      id: "goal",
      title: "Parallel roots",
      objective: "Use available concurrency",
      nodes: [
        { id: "root-a", title: "Root A", priority: 2 },
        { id: "root-b", title: "Root B", priority: 1 },
        { id: "child", title: "Child", dependsOn: ["root-a", "root-b"], priority: 100 },
      ],
    });

    const claims = await setup.scheduler.claimReady();

    expect(claims.map((claim) => claim.task.id)).toEqual(["root-a", "root-b"]);
    expect(setup.scheduler.snapshot().tasks.find((task) => task.id === "child")?.status).toBe("blocked");
    expect(new Set(claims.map((claim) => claim.lease.idempotencyKey)).size).toBe(2);
  });

  test("reprioritizes queued work without preempting an active lease", async () => {
    const setup = scheduler(undefined, 1);
    await setup.scheduler.initialize();
    await setup.scheduler.createGoal({
      id: "goal-priority",
      title: "Priority",
      objective: "Dispatch by operator priority",
      nodes: [
        { id: "active", title: "Active", priority: 5 },
        { id: "queued-low", title: "Low", priority: 1 },
        { id: "queued-high", title: "High", priority: 2 },
      ],
    });

    const [active] = await setup.scheduler.claimReady();
    expect(active?.task.id).toBe("active");
    await setup.scheduler.applyAction("queued-low", { type: "reprioritize", priority: 20 });
    expect(await setup.scheduler.claimReady()).toEqual([]);

    await setup.scheduler.complete("active", active!.lease.id, { summary: "Done" });
    const [next] = await setup.scheduler.claimReady();
    expect(next?.task.id).toBe("queued-low");
  });

  test("coordinator and operator calls share validation and persistence", async () => {
    const setup = scheduler();
    await setup.scheduler.initialize();
    await setup.scheduler.createGoal({
      id: "goal-actions",
      title: "Actions",
      objective: "Use one service boundary",
      nodes: [{ id: "task", title: "Task" }],
    });

    await expect(setup.scheduler.applyAction("task", { type: "reprioritize", priority: 101 })).rejects.toThrow("priority");
    expect(setup.store.writes).toBe(1);

    await setup.scheduler.applyAction("task", { type: "message", text: "Check the release notes" });
    expect(setup.scheduler.snapshot().tasks[0]?.messages[0]?.text).toBe("Check the release notes");
    expect(setup.store.writes).toBe(2);
  });

  test("persists the fenced lease before invoking a harness executor", async () => {
    const setup = scheduler(undefined, 1);
    await setup.scheduler.initialize();
    await setup.scheduler.createGoal({
      id: "goal-dispatch",
      title: "Dispatch",
      objective: "Fence side effects",
      nodes: [{ id: "dispatch-me", title: "Dispatch me" }],
    });

    const result = await setup.scheduler.dispatchReady(async (claim) => {
      const stored = JSON.parse(setup.store.value!) as { tasks: Array<{ id: string; status: string; lease?: { id: string } }> };
      expect(stored.tasks.find((task) => task.id === claim.task.id)).toMatchObject({ status: "running", lease: { id: claim.lease.id } });
      return { summary: "Harness completed" };
    });

    expect(result).toEqual([{ taskId: "dispatch-me", status: "succeeded" }]);
    expect(setup.scheduler.snapshot().tasks[0]?.status).toBe("succeeded");
  });

  test("fences an active task when the operator pauses it", async () => {
    const setup = scheduler(undefined, 1);
    await setup.scheduler.initialize();
    await setup.scheduler.createGoal({
      id: "goal-interrupt",
      title: "Interrupt",
      objective: "Fence active work",
      nodes: [{ id: "active", title: "Active" }],
    });
    const [claim] = await setup.scheduler.claimReady();
    await setup.scheduler.start(claim!.task.id, claim!.lease.id);

    await setup.scheduler.interrupt(claim!.task.id, claim!.lease.id, "paused");

    expect(setup.scheduler.snapshot().tasks[0]).toMatchObject({ status: "paused", lease: undefined });
    await expect(setup.scheduler.complete(claim!.task.id, claim!.lease.id, { summary: "Stale result" })).rejects.toThrow("stale");
  });

  test("reports a safe-boundary pause without converting it into a task failure", async () => {
    const setup = scheduler(undefined, 1);
    await setup.scheduler.initialize();
    await setup.scheduler.createGoal({ id: "goal-pause", title: "Pause", objective: "Pause safely", nodes: [{ id: "pause-me", title: "Pause me" }] });

    const results = await setup.scheduler.dispatchReady(async (claim) => {
      await setup.scheduler.interrupt(claim.task.id, claim.lease.id, "paused");
      throw new TaskExecutionPausedError();
    });

    expect(results).toEqual([{ taskId: "pause-me", status: "paused" }]);
    expect(setup.scheduler.snapshot().tasks[0]).toMatchObject({ status: "paused", outcome: undefined });
  });

  test("reconciles live lease expiry before claiming capacity and fences stale completion", async () => {
    const setup = scheduler(undefined, 1);
    await setup.scheduler.initialize();
    await setup.scheduler.createGoal({
      id: "goal-recovery",
      title: "Recover live work",
      objective: "Resume from the last checkpoint",
      nodes: [{ id: "recover-me", title: "Recover me" }],
    });

    const [first] = await setup.scheduler.claimReady();
    await setup.scheduler.checkpoint("recover-me", first!.lease.id, { cursor: "step-4", recoverable: true });
    setup.setNow(first!.lease.expiresAt);

    await expect(setup.scheduler.complete("recover-me", first!.lease.id, { summary: "Too late" })).rejects.toThrow("expired");

    const [recovered] = await setup.scheduler.claimReady();
    expect(recovered?.task.id).toBe("recover-me");
    expect(recovered?.checkpoint?.cursor).toBe("step-4");
    expect(recovered?.lease.id).not.toBe(first!.lease.id);
    expect(recovered?.task.attempts).toHaveLength(2);
    expect(recovered?.task.attempts[0]).toMatchObject({ status: "interrupted", recovery: "expired-lease" });
  });
});
