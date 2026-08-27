import { describe, expect, test } from "vitest";
import { TraceService } from "../src/main/quality/trace-service";
import type { ControlPlaneEvent } from "../src/shared/control-plane-contracts";

function event(sequence: number, patch: Partial<ControlPlaneEvent> = {}): ControlPlaneEvent {
  return { id: `event-${sequence}`, aggregateId: "run-a", runId: "run-a", sequence, timestamp: sequence * 10, source: "test", type: "provider.activity", schemaVersion: 1, payload: {}, ...patch };
}

describe("TraceService", () => {
  test("returns exact event order with stable cross-links across source rebuild order", async () => {
    const source = { events: async () => [
      event(3, { timestamp: 30, taskId: "task-a", payload: { harnessId: "pi", tool: "read_file" } }),
      event(1, { timestamp: 10, taskId: "task-a", payload: { goalId: "goal-a", agentId: "builder" } }),
      event(2, { timestamp: 20, taskId: "task-b", payload: { harnessId: "codex" } }),
    ], deleteExpiredArtifacts: async () => 0 };
    const trace = await new TraceService(source, () => 99).query({ taskId: "task-a" });
    expect(trace.events.map(({ event }) => event.id)).toEqual(["event-1", "event-3"]);
    expect(trace.events[0]?.links).toMatchObject({ goalId: "goal-a", runId: "run-a", taskId: "task-a", agentId: "builder" });
    expect(trace.events[1]?.links).toMatchObject({ harnessId: "pi", tool: "read_file" });
    expect(trace.generatedAt).toBe(99);
  });

  test("applies artifact retention without removing event metadata", async () => {
    const source = { events: async () => [event(1)], deleteExpiredArtifacts: async (now: number) => now === 99 ? 2 : 0 };
    const service = new TraceService(source, () => 99);
    expect(await service.applyRetention()).toBe(2);
    expect((await service.query()).events).toHaveLength(1);
  });
});
