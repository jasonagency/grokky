import type { AppSettings } from "../../shared/contracts";
import type {
  HarnessControl,
  HarnessControlResult,
  HarnessDescriptor,
  HarnessHealth,
} from "../../shared/harness-contracts";
import type { ProviderEvent, ProviderRunContext } from "../providers/types";

const MAX_HARNESS_EVENT_BYTES = 2 * 1024 * 1024;

export interface HarnessHealthContext {
  settings: AppSettings;
  homeDirectory: string;
}

export interface HarnessAdapter {
  descriptor: HarnessDescriptor;
  health(context: HarnessHealthContext): Promise<HarnessHealth>;
  run(context: ProviderRunContext): Promise<void>;
  deliverControl(control: HarnessControl): Promise<HarnessControlResult>;
  cleanup(): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateHarnessEvent(value: unknown): ProviderEvent {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") throw new Error("Invalid harness event");
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > MAX_HARNESS_EVENT_BYTES) throw new Error(`Harness event exceeds the ${MAX_HARNESS_EVENT_BYTES}-byte limit`);
  if (!isObject(value) || typeof value.type !== "string") throw new Error("Invalid harness event");
  if (value.type === "thread") {
    if (typeof value.threadId !== "string" || !value.threadId || value.threadId.length > 500) throw new Error("Invalid harness thread event");
  } else if (value.type === "final") {
    if (typeof value.text !== "string") throw new Error("Invalid harness final event");
  } else if (value.type === "activity") {
    if (!isObject(value.activity) || typeof value.activity.id !== "string" || typeof value.activity.label !== "string") throw new Error("Invalid harness activity event");
  } else if (value.type === "orchestration") {
    if (!isObject(value.event) || typeof value.event.operationId !== "string" || !Array.isArray(value.event.receiverThreads)) throw new Error("Invalid harness orchestration event");
  } else if (value.type === "usage") {
    if (!isObject(value.usage) || !nonNegative(value.usage.inputTokens) || !nonNegative(value.usage.outputTokens)) throw new Error("Invalid harness usage event");
  } else {
    throw new Error(`Unsupported harness event type: ${value.type.slice(0, 80)}`);
  }
  return structuredClone(value) as ProviderEvent;
}
