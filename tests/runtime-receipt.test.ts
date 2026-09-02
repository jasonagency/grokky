import { describe, expect, test } from "vitest";
import { runtimeReceiptParts } from "../src/renderer/src/runtime-receipt";

describe("runtime receipts", () => {
  test("distinguishes the selected model from the upstream-resolved model", () => {
    expect(runtimeReceiptParts({
      provider: "openrouter",
      harnessId: "openrouter-chat",
      requestedModel: "openrouter/auto",
      resolvedModel: "anthropic/claude-sonnet-4.6",
      reasoning: "high",
    })).toEqual([
      "OpenRouter",
      "openrouter-chat",
      "requested openrouter/auto",
      "resolved anthropic/claude-sonnet-4.6",
      "high reasoning",
    ]);
  });

  test("shows one model label when requested and resolved match", () => {
    expect(runtimeReceiptParts({
      provider: "pi",
      harnessId: "pi-native",
      requestedModel: "openrouter/openai/gpt-5.2",
      resolvedModel: "openrouter/openai/gpt-5.2",
      reasoning: "medium",
    })).toEqual(["Pi", "pi-native", "model openrouter/openai/gpt-5.2", "medium reasoning"]);
  });

  test("does not present an unresolved requested model as verified", () => {
    expect(runtimeReceiptParts({
      provider: "codex",
      harnessId: "codex-sdk",
      requestedModel: "gpt-5.6-sol",
      reasoning: "high",
    })).toEqual(["Codex", "codex-sdk", "requested gpt-5.6-sol", "resolved unavailable", "high reasoning"]);
  });
});
