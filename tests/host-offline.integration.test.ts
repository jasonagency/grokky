import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { HostClient, type HostTransport } from "../src/main/remote/host-client";
import { HostReconciler } from "../src/main/remote/host-reconciler";
import { RemoteStateRepository } from "../src/main/storage/repositories/remote-state-repository";
import { AgentHost } from "../src/runner/agent-host";
import { HostHarnessRegistry } from "../src/runner/host-harness-registry";
import { HostStore } from "../src/runner/host-store";

function transport(host: AgentHost): HostTransport { return { capabilities: async () => host.capabilities(), submit: (credential, request) => host.submit(credential, request), events: async (credential, cursor, limit) => host.events(credential, cursor, limit), control: (credential, command) => host.control(credential, command) }; }
async function eventually(check: () => boolean): Promise<void> { for (let index = 0; index < 100; index += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error("condition not reached"); }

describe("offline remote host", () => {
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

  test("host restart marks an unrecoverable active harness interrupted and retains its spool", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-host-restart-"));
    const pathname = join(directory, "host.json");
    const firstStore = new HostStore(pathname); await firstStore.initialize();
    await firstStore.mutate((state) => { state.jobs.push({ id: "job", idempotencyKey: "once", taskId: "task", attemptId: "attempt", leaseEpoch: 1, harnessId: "fixture", payload: {}, approvalPolicy: "ask", budgetUsd: 1, status: "running", createdAt: 1, updatedAt: 1 }); });
    const registry = new HostHarnessRegistry(); registry.register("fixture", async () => "done");
    const restarted = new AgentHost("host", new HostStore(pathname), registry, "secret", () => 20); await restarted.initialize();
    await eventually(() => restarted.snapshot().jobs[0]?.status === "interrupted");
    expect(restarted.snapshot().jobs[0]).toMatchObject({ status: "interrupted", error: "Host restarted while the harness was running" });
  });
});
