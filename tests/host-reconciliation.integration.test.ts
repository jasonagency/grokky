import { describe, expect, test } from "vitest";
import { HostClient, type HostTransport } from "../src/main/remote/host-client";
import { FetchHostTransport } from "../src/main/remote/host-client";
import { HostReconciler } from "../src/main/remote/host-reconciler";
import { RemoteStateRepository } from "../src/main/storage/repositories/remote-state-repository";
import { AgentHost } from "../src/runner/agent-host";
import { HostHarnessRegistry } from "../src/runner/host-harness-registry";
import { HostStore } from "../src/runner/host-store";
import type { RemoteReconciliationState } from "../src/shared/remote-protocol";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRunnerServer } from "../src/main/runner-service";

function transport(host: AgentHost): HostTransport { return { capabilities: async () => host.capabilities(), submit: (credential, request) => host.submit(credential, request), events: async (credential, cursor, limit) => host.events(credential, cursor, limit), control: (credential, command) => host.control(credential, command) }; }
function remoteDatabase() { let value: string | null = null; return { readRemoteState: async () => value, writeRemoteState: async (next: string) => { value = next; } }; }
async function eventually(check: () => boolean): Promise<void> { for (let index = 0; index < 100; index += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error("condition not reached"); }

describe("remote host reconciliation", () => {
  test("deduplicates job submission and reconciles ordered signed events", async () => {
    const registry = new HostHarnessRegistry(); registry.register("fixture", async () => "done");
    const host = new AgentHost("host", new HostStore(), registry, "secret", () => 10); await host.initialize();
    const client = new HostClient("http://127.0.0.1:4747", "secret", transport(host)); await client.connect();
    const request = { id: "job", idempotencyKey: "once", taskId: "task", attemptId: "attempt", leaseEpoch: 1, harnessId: "fixture", payload: {}, approvalPolicy: "ask" as const, budgetUsd: 1 };
    expect((await client.submit(request)).id).toBe("job");
    expect((await client.submit({ ...request, id: "job-retry" })).id).toBe("job");
    await expect(client.submit({ ...request, id: "partitioned", idempotencyKey: "partitioned", leaseEpoch: 2 })).rejects.toThrow("owned by host job");
    await eventually(() => host.snapshot().jobs[0]?.status === "succeeded");
    expect(host.snapshot().jobs).toHaveLength(1);
    const reconciler = new HostReconciler(new RemoteStateRepository(remoteDatabase()), client); await reconciler.initialize();
    expect(await reconciler.reconcile()).toMatchObject({ accepted: 3, duplicates: 0 });
    expect((await reconciler.reconcile()).accepted).toBe(0);
    expect(reconciler.snapshot().events.map((event) => event.type)).toEqual(["job.accepted", "job.running", "job.completed"]);
  });

  test("sorts out-of-order frames, requests bounded gap recovery, and fences stale epochs", async () => {
    const registry = new HostHarnessRegistry(); registry.register("fixture", async () => "done");
    const host = new AgentHost("host", new HostStore(), registry, "secret", () => 10); await host.initialize();
    const client = new HostClient("http://127.0.0.1:4747", "secret", transport(host)); await client.connect();
    const database = remoteDatabase();
    await database.writeRemoteState(JSON.stringify({ revision: 1, hostId: "host", acknowledgedCursor: 0, events: [], leaseEpochs: { job: 2 }, diagnostics: [] } satisfies RemoteReconciliationState));
    const reconciler = new HostReconciler(new RemoteStateRepository(database), client); await reconciler.initialize();
    const frames = [
      { protocolMajor: 1, cursor: 2, jobId: "job", leaseEpoch: 2, type: "job.running" as const, payload: {}, timestamp: 2, signature: "unused" },
      { protocolMajor: 1, cursor: 1, jobId: "job", leaseEpoch: 1, type: "job.accepted" as const, payload: {}, timestamp: 1, signature: "unused" },
    ];
    expect(await reconciler.apply(frames)).toMatchObject({ accepted: 1, stale: 1 });
    expect((await reconciler.apply([{ ...frames[1]!, cursor: 4 }])).gapAfter).toBe(2);
    expect(reconciler.snapshot().diagnostics[0]?.detail).toContain("stale lease epoch");
  });

  test("runs the authenticated protocol over the private runner transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokky-network-host-"));
    const runner = await startRunnerServer({ root, statePath: join(root, "runner.json"), host: "127.0.0.1", port: 0, agentHostFactory: (credential, deviceId) => { const registry = new HostHarnessRegistry(); registry.register("fixture", async () => "network-done"); return new AgentHost(deviceId, new HostStore(join(root, "jobs.json")), registry, credential); } });
    try {
      const pairing = await fetch(`${runner.endpoint}/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runner.code }) });
      const { token } = await pairing.json() as { token: string };
      const client = new HostClient(runner.endpoint, token, new FetchHostTransport(runner.endpoint));
      await client.connect();
      await client.submit({ id: "network-job", idempotencyKey: "network-once", taskId: "network-task", attemptId: "attempt", leaseEpoch: 1, harnessId: "fixture", payload: {}, approvalPolicy: "ask", budgetUsd: 1 });
      for (let index = 0; index < 100 && (await client.events(0)).at(-1)?.type !== "job.completed"; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
      expect((await client.events(0)).at(-1)?.type).toBe("job.completed");
    } finally { await runner.close(); }
  });

  test("expires pairing codes and rate-limits guesses", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokky-network-host-"));
    let now = 1_000;
    const runner = await startRunnerServer({ root, statePath: join(root, "runner.json"), host: "127.0.0.1", port: 0, pairingCodeTtlMs: 30_000, pairingAttemptLimit: 2, now: () => now });
    try {
      const guess = () => fetch(`${runner.endpoint}/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "invalid" }) });
      expect((await guess()).status).toBe(403);
      expect((await guess()).status).toBe(403);
      expect((await fetch(`${runner.endpoint}/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runner.code }) })).status).toBe(429);
    } finally { await runner.close(); }

    const expiring = await startRunnerServer({ root, statePath: join(root, "runner-2.json"), host: "127.0.0.1", port: 0, pairingCodeTtlMs: 30_000, now: () => now });
    try {
      now += 30_000;
      expect((await fetch(`${expiring.endpoint}/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: expiring.code }) })).status).toBe(429);
    } finally { await expiring.close(); }
  });
});
