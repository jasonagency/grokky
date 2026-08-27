import { describe, expect, test } from "vitest";
import { EvalService } from "../src/main/quality/eval-service";
import type { EvalStateSnapshot, TraceBundle } from "../src/shared/control-plane-contracts";

const trace: TraceBundle = { query: {}, generatedAt: 1, events: [{ ordinal: 0, links: {}, event: { id: "event", aggregateId: "run", sequence: 1, timestamp: 1, source: "test", type: "run.completed", schemaVersion: 1, payload: { authorization: "Bearer secret", output: "variable prose" } } }] };

describe("EvalService", () => {
  test("redacts promoted traces, persists versions, and compares deterministic outcomes independently of prose", async () => {
    let stored: string | null = null;
    const database = { readQualityState: async () => stored, writeQualityState: async (value: string) => { stored = value; } };
    const service = new EvalService(database, () => 10);
    await service.initialize();
    const entry = await service.promote({ id: "coding", name: "Coding task", trace, expectedOutcome: "completed", verificationRules: [{ type: "event-present", eventType: "run.completed" }, { type: "no-policy-violations" }] });
    expect(JSON.stringify(entry)).not.toContain("Bearer secret");
    expect(JSON.stringify(entry)).toContain("redacted:");
    const baseline = await service.grade("coding", 1, trace, { costUsd: 1, latencyMs: 100, toolCount: 1, policyViolations: 0 });
    const differentText = structuredClone(trace);
    (differentText.events[0]!.event.payload as Record<string, unknown>).output = "different generated prose";
    const candidate = await service.grade("coding", 1, differentText, { costUsd: 0.5, latencyMs: 90, toolCount: 1, policyViolations: 1 });
    const comparison = service.compare(baseline.id, candidate.id);
    expect(comparison).toMatchObject({ deterministicRegression: true, delta: { costUsd: -0.5, latencyMs: -10, policyViolations: 1 } });
    expect((JSON.parse(stored!) as EvalStateSnapshot).runs).toHaveLength(2);
  });
});
