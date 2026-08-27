import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LeaseReconciler } from "../src/main/control-plane/lease-reconciler";
import { TaskScheduler } from "../src/main/control-plane/scheduler";
import { DirectDatabaseClient } from "../src/main/storage/database-client";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((pathname) => rm(pathname, { recursive: true, force: true })));
});

describe("scheduler restart recovery", () => {
  test("keeps terminal work, reconciles one expired lease once, and gates its dependent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-scheduler-"));
    temporaryDirectories.push(directory);
    const pathname = join(directory, "control-plane.sqlite");
    let now = 1_000;
    let sequence = 0;
    const options = {
      concurrency: 2,
      leaseDurationMs: 100,
      now: () => now,
      id: (prefix: string) => `${prefix}-${++sequence}`,
    };

    const firstDatabase = new DirectDatabaseClient(pathname);
    await firstDatabase.initialize();
    const first = new TaskScheduler(firstDatabase, options);
    await first.initialize();
    await first.createGoal({
      id: "goal-restart",
      title: "Restart",
      objective: "Recover without duplicate effects",
      nodes: [
        { id: "completed", title: "Completed" },
        { id: "active", title: "Active" },
        { id: "dependent", title: "Dependent", dependsOn: ["active"] },
      ],
    });
    const claims = await first.claimReady();
    const completed = claims.find((claim) => claim.task.id === "completed")!;
    const active = claims.find((claim) => claim.task.id === "active")!;
    await first.complete("completed", completed.lease.id, { summary: "Already done" });
    await first.start("active", active.lease.id);
    await first.checkpoint("active", active.lease.id, { cursor: "step-2", recoverable: true });
    await firstDatabase.close();

    now = 1_101;
    const secondDatabase = new DirectDatabaseClient(pathname);
    await secondDatabase.initialize();
    const second = new TaskScheduler(secondDatabase, options);
    await second.initialize();
    const reconciler = new LeaseReconciler(second);

    expect(await reconciler.reconcileExpired()).toEqual(["active"]);
    expect(await reconciler.reconcileExpired()).toEqual([]);
    expect(second.snapshot().tasks.find((task) => task.id === "completed")?.status).toBe("succeeded");
    expect(second.snapshot().tasks.find((task) => task.id === "active")?.attempts).toHaveLength(1);
    expect(second.snapshot().tasks.find((task) => task.id === "active")?.attempts[0]).toMatchObject({
      status: "interrupted",
      recovery: "expired-lease",
    });
    expect(second.snapshot().tasks.find((task) => task.id === "dependent")?.status).toBe("blocked");

    const [retry] = await second.claimReady();
    expect(retry?.task.id).toBe("active");
    await second.complete("active", retry!.lease.id, { summary: "Recovered from step-2" });
    const [dependent] = await second.claimReady();
    expect(dependent?.task.id).toBe("dependent");
    await secondDatabase.close();
  });
});
