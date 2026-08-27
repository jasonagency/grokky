import { describe, expect, test } from "vitest";
import { FetchRemoteScreenTransport, ScreenClient, type RemoteScreenTransport } from "../src/main/remote/screen-client";
import { ScreenSessionManager, type ScreenProvider } from "../src/runner/screen-session-manager";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRunnerServer } from "../src/main/runner-service";
import { AgentHost } from "../src/runner/agent-host";
import { HostStore } from "../src/runner/host-store";
import { HostHarnessRegistry } from "../src/runner/host-harness-registry";

describe("remote screen takeover", () => {
  test("pauses agent input, accepts secret human input without tracing content, and resumes only on return", async () => {
    const inputs: unknown[] = []; const provider: ScreenProvider = { kind: "desktop", create: async () => ({ sessionId: "desktop", delivery: "snapshot" }), capture: async () => ({ mediaType: "image/png", data: "frame" }), input: async (_id, input) => { inputs.push(input); }, close: async () => undefined };
    const manager = new ScreenSessionManager([provider]);
    const transport: RemoteScreenTransport = { snapshot: async () => manager.snapshot(), lease: (agentId, kind) => manager.lease(agentId, kind), capture: (id, epoch) => manager.capture(id, epoch), agentInput: (id, epoch, agentId, input) => manager.agentInput(id, epoch, agentId, input), takeover: async (id, epoch) => manager.takeover(id, epoch), operatorInput: (id, epoch, input) => manager.operatorInput(id, epoch, input), returnControl: async (id, epoch) => manager.returnControl(id, epoch), lock: async (id, epoch) => manager.lock(id, epoch), revoke: (id, epoch) => manager.revoke(id, epoch) };
    const client = new ScreenClient(transport); const lease = await client.lease("agent:a", "desktop");
    await expect(client.input(lease.id, lease.epoch, "agent:a", { type: "key", key: "human-secret-value", sensitivity: "password" })).rejects.toThrow("human-only");
    await client.takeover(lease.id, lease.epoch);
    await expect(client.input(lease.id, lease.epoch, "agent:a", { type: "click", x: 1, y: 1 })).rejects.toThrow("blocked");
    await client.operatorInput(lease.id, lease.epoch, { type: "key", key: "human-secret-value", sensitivity: "password" });
    expect(JSON.stringify(await client.snapshot())).not.toContain("human-secret-value");
    await client.returnControl(lease.id, lease.epoch); await expect(client.input(lease.id, lease.epoch, "agent:a", { type: "click", x: 2, y: 2 })).resolves.toBeUndefined();
    expect(inputs).toHaveLength(2);
  });

  test("performs takeover through the authenticated remote screen transport", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-screen-network-")); const provider: ScreenProvider = { kind: "browser", create: async () => ({ sessionId: "page", delivery: "snapshot" }), capture: async () => ({ mediaType: "image/png", data: "frame" }), input: async () => undefined, close: async () => undefined };
    const runner = await startRunnerServer({ root: directory, statePath: join(directory, "runner.json"), host: "127.0.0.1", port: 0, agentHostFactory: (credential, deviceId) => new AgentHost(deviceId, new HostStore(join(directory, "host.json")), new HostHarnessRegistry(), credential, Date.now, new ScreenSessionManager([provider])) });
    try {
      const response = await fetch(`${runner.endpoint}/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: runner.code }) }); const { token } = await response.json() as { token: string };
      const client = new ScreenClient(new FetchRemoteScreenTransport(runner.endpoint, token)); const lease = await client.lease("agent:remote", "browser"); expect((await client.takeover(lease.id, lease.epoch)).controller).toBe("operator"); expect((await client.returnControl(lease.id, lease.epoch)).controller).toBe("agent");
    } finally { await runner.close(); }
  });
});
