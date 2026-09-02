import type { RunRuntimeReceipt } from "../../shared/contracts";

const providerLabels: Record<RunRuntimeReceipt["provider"], string> = {
  codex: "Codex",
  openrouter: "OpenRouter",
  pi: "Pi",
};

export function providerLabel(provider: RunRuntimeReceipt["provider"]): string {
  return providerLabels[provider];
}

export function runtimeReceiptParts(runtime: RunRuntimeReceipt): string[] {
  const models = !runtime.resolvedModel
    ? [`requested ${runtime.requestedModel}`, "resolved unavailable"]
    : runtime.resolvedModel !== runtime.requestedModel
      ? [`requested ${runtime.requestedModel}`, `resolved ${runtime.resolvedModel}`]
      : [`model ${runtime.resolvedModel}`];
  return [providerLabel(runtime.provider), runtime.harnessId, ...models, `${runtime.reasoning} reasoning`];
}
