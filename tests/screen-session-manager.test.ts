import { describe, expect, test } from "vitest";
import { ScreenSessionManager, type ScreenProvider } from "../src/runner/screen-session-manager";

function provider(inputs: Array<{ sessionId: string; input: unknown }>): ScreenProvider {
  let id = 0; return { kind: "browser", create: async () => ({ sessionId: `page-${++id}`, delivery: "stream" }), capture: async () => ({ mediaType: "image/png", data: "frame" }), input: async (sessionId, input) => { inputs.push({ sessionId, input }); }, close: async () => undefined };
}

describe("ScreenSessionManager", () => {
  test("binds distinct screen leases and all input to the owning agent and epoch", async () => {
    const inputs: Array<{ sessionId: string; input: unknown }> = []; const manager = new ScreenSessionManager([provider(inputs)], () => 10, 100);
    const first = await manager.lease("agent:a", "browser"); const second = await manager.lease("agent:b", "browser");
    expect(first.providerSessionId).not.toBe(second.providerSessionId);
    await manager.agentInput(first.id, first.epoch, "agent:a", { type: "click", x: 10, y: 20 });
    await expect(manager.agentInput(first.id, first.epoch, "agent:b", { type: "click", x: 1, y: 1 })).rejects.toThrow("does not own");
    expect(inputs).toEqual([{ sessionId: first.providerSessionId, input: { type: "click", x: 10, y: 20 } }]);
    await manager.capture(first.id, first.epoch);
    expect(manager.snapshot().history).toEqual([expect.objectContaining({ leaseId: first.id, sequence: 1, mediaType: "image/png" })]);
    expect(JSON.stringify(manager.snapshot().history)).not.toContain("frame");
  });

  test("rejects expired and revoked leases and records the failure", async () => {
    let now = 10; const manager = new ScreenSessionManager([provider([])], () => now, 5); const lease = await manager.lease("agent:a", "browser"); now = 20;
    await expect(manager.capture(lease.id, lease.epoch)).rejects.toThrow("expired");
    expect(manager.snapshot().audit.at(-1)).toMatchObject({ action: "failure", status: "failed" });
  });

  test("marks snapshot fallback when a stream capture disconnects", async () => {
    const failing: ScreenProvider = { kind: "browser", create: async () => ({ sessionId: "page", delivery: "stream" }), capture: async () => { throw new Error("stream disconnected"); }, input: async () => undefined, close: async () => undefined };
    const manager = new ScreenSessionManager([failing]); const lease = await manager.lease("agent:a", "browser");
    await expect(manager.capture(lease.id, lease.epoch)).rejects.toThrow("stream disconnected");
    expect(manager.snapshot().leases[0]?.delivery).toBe("snapshot");
  });
});
