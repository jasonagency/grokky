import { describe, expect, test } from "vitest";
import { BudgetService } from "../src/main/control-plane/budget-service";

describe("budget service", () => {
  test("blocks the next enforceable call at a hard token ceiling", () => {
    const decision = new BudgetService().evaluate({ hard: { tokens: 100 }, soft: {}, reserveFraction: 0.1 }, { tokens: { value: 100, quality: "authoritative" }, elapsedMs: { value: 5, quality: "authoritative" } }, { enforceableBoundary: true });
    expect(decision).toMatchObject({ status: "blocked", metric: "tokens", enforceability: "hard" });
  });

  test("pauses at a soft threshold and reserves against delayed cost", () => {
    const decision = new BudgetService().evaluate({ hard: { costUsd: 11 }, soft: { costUsd: 9 }, reserveFraction: 0.2 }, { costUsd: { value: 8, quality: "delayed" } }, { enforceableBoundary: true });
    expect(decision).toMatchObject({ status: "paused", metric: "costUsd", measured: 9.6 });
  });

  test("labels unavailable cost advisory and never substitutes zero", () => {
    const decision = new BudgetService().evaluate({ hard: { costUsd: 1 }, soft: {}, reserveFraction: 0.2 }, { costUsd: { quality: "unavailable" } }, { enforceableBoundary: true });
    expect(decision).toMatchObject({ status: "advisory", metric: "costUsd", measured: null, enforceability: "advisory" });
  });
});
