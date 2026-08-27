import { describe, expect, test, vi } from "vitest";
import { ReplayService } from "../src/main/quality/replay-service";
import type { TraceBundle } from "../src/shared/control-plane-contracts";

const trace: TraceBundle = { query: {}, generatedAt: 1, events: [{ ordinal: 0, links: { tool: "read_file" }, event: { id: "event", aggregateId: "run", runId: "run", sequence: 1, timestamp: 1, source: "test", type: "provider.activity", schemaVersion: 1, payload: { tool: "read_file", result: "contents" } } }] };

describe("ReplayService", () => {
  test("inspection replay executes zero adapter or tool calls", async () => {
    const execute = vi.fn();
    const result = await new ReplayService({ execute }).replay({ mode: "inspection", trace });
    expect(result).toMatchObject({ executed: false, substitutions: [] });
    expect(execute).not.toHaveBeenCalled();
  });

  test("simulated replay substitutes every recorded tool result without execution", async () => {
    const execute = vi.fn();
    const result = await new ReplayService({ execute }).replay({ mode: "simulated", trace });
    expect(result.substitutions).toEqual([{ ordinal: 0, tool: "read_file", result: "contents", substituted: true }]);
    expect(execute).not.toHaveBeenCalled();
  });

  test("forked replay requires a disposable lease and current approval and budget", async () => {
    const execute = vi.fn(async () => trace.events);
    const service = new ReplayService({ execute });
    await expect(service.replay({ mode: "forked", trace })).rejects.toThrow("disposable");
    await expect(service.replay({ mode: "forked", trace, disposableLease: { id: "lease", disposable: true }, approvalGranted: false, budgetRemainingUsd: 1 })).rejects.toThrow("approval");
    const result = await service.replay({ mode: "forked", trace, disposableLease: { id: "lease", disposable: true }, approvalGranted: true, budgetRemainingUsd: 1 });
    expect(result.executed).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });
});
