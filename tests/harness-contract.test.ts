import { describe, expect, test } from "vitest";
import { validateHarnessEvent } from "../src/main/harnesses/types";

describe("harness event contract", () => {
  test("accepts normalized provider events and rejects malformed or oversized events", () => {
    expect(validateHarnessEvent({ type: "final", text: "Done" })).toEqual({ type: "final", text: "Done" });
    expect(validateHarnessEvent({ type: "final", text: "Done", runtime: { provider: "pi", harnessId: "pi-native", requestedModel: "auto", resolvedModel: "openrouter/openai/gpt-5.2", reasoning: "medium" } }))
      .toMatchObject({ runtime: { provider: "pi", resolvedModel: "openrouter/openai/gpt-5.2" } });
    expect(validateHarnessEvent({ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } })).toEqual({ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } });
    expect(() => validateHarnessEvent({ type: "final", text: "x".repeat(2_100_000) })).toThrow("Harness event exceeds");
    expect(() => validateHarnessEvent({ type: "usage", usage: { inputTokens: -1, outputTokens: 5 } })).toThrow("Invalid harness usage event");
    expect(() => validateHarnessEvent({ type: "final", text: "Done", runtime: { provider: "pi", harnessId: "pi-native", requestedModel: "auto", reasoning: "unlimited" } })).toThrow("Invalid harness runtime receipt");
    expect(() => validateHarnessEvent({ type: "secret", apiKey: "should-not-appear" })).toThrow("Unsupported harness event type");
  });
});
