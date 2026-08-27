import { describe, expect, test } from "vitest";
import { SteeringService, type ControlRuntimeStore } from "../src/main/control-plane/steering-service";

class MemoryRuntimeStore implements ControlRuntimeStore {
  value: string | null = null;
  writes: string[] = [];
  async readControlRuntime() { return this.value; }
  async writeControlRuntime(value: string) { this.value = value; this.writes.push(value); }
}

describe("steering service", () => {
  test("persists a redirect before delivery and records acknowledgement", async () => {
    const store = new MemoryRuntimeStore();
    const service = new SteeringService(store, () => 100);
    await service.initialize();
    const command = await service.queue({ taskId: "task", harnessId: "codex-app-server", type: "redirect", message: "Use the release branch", idempotencyKey: "redirect-1" });

    let stateSeenDuringDelivery = "";
    await service.deliver(command.id, async () => {
      stateSeenDuringDelivery = JSON.parse(store.value!).commands[0].status;
      return { accepted: true };
    });

    expect(stateSeenDuringDelivery).toBe("delivered");
    expect(service.snapshot().commands[0]?.status).toBe("acknowledged");
  });

  test("deduplicates identical commands and rejects unsupported delivery visibly", async () => {
    const service = new SteeringService(new MemoryRuntimeStore());
    await service.initialize();
    const first = await service.queue({ taskId: "task", harnessId: "compat", type: "pause", idempotencyKey: "pause-1" });
    const second = await service.queue({ taskId: "task", harnessId: "compat", type: "pause", idempotencyKey: "pause-1" });
    expect(second.id).toBe(first.id);

    await service.deliver(first.id, async () => ({ accepted: false, reason: "Pause waits for a safe boundary" }));
    expect(service.snapshot().commands[0]).toMatchObject({ status: "rejected", detail: "Pause waits for a safe boundary" });
  });
});
