import { describe, expect, test } from "vitest";
import { PolicyEngine } from "../src/main/control-plane/policy-engine";
import type { HarnessRegistryEntry } from "../src/shared/harness-contracts";

function harness(id: string, cost: number, tools: boolean): HarnessRegistryEntry {
  return { id, version: "1", displayName: id, providerCompatibility: [], models: [{ id: "model", label: "model" }], capabilities: { sessionPersistence: true, streaming: true, steering: "follow-up", cancellation: true, tools, mcp: false, usage: "authoritative", computerControl: false, multiAgent: false }, health: { ready: true, label: "ready", source: "test", detail: "ready" }, estimatedInputCostPerMillion: cost, estimatedOutputCostPerMillion: cost };
}

describe("policy engine", () => {
  test("chooses the lowest-cost ready compatible route", () => {
    const decision = new PolicyEngine().route([harness("cheap-no-tools", 1, false), harness("compatible", 4, true), harness("expensive", 10, true)], { requiredCapabilities: { tools: true }, preferredModels: [] });
    expect(decision).toMatchObject({ status: "selected", harnessId: "compatible", model: "model" });
    expect(decision.rejections).toContainEqual(expect.objectContaining({ harnessId: "cheap-no-tools", reason: expect.stringContaining("tools") }));
  });

  test("refuses every route when required capabilities are absent", () => {
    expect(new PolicyEngine().route([harness("plain", 1, false)], { requiredCapabilities: { tools: true }, preferredModels: [] })).toMatchObject({ status: "rejected" });
  });
});
