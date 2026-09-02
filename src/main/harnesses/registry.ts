import type { Conversation, ProviderId, ProviderStatus } from "../../shared/contracts";
import type {
  HarnessControl,
  HarnessControlResult,
  HarnessCapabilities,
  HarnessRegistryEntry,
  RequiredHarnessCapabilities,
} from "../../shared/harness-contracts";
import type { ProviderRunContext } from "../providers/types";
import { CodexSdkAdapter } from "./codex-sdk-adapter";
import { CodexAppServerAdapter } from "./codex-app-server-adapter";
import { OpenRouterAdapter } from "./openrouter-adapter";
import { PiAdapter } from "./pi-adapter";
import type { HarnessAdapter } from "./types";
import { validateHarnessEvent } from "./types";

const CAPABILITY_LABELS: Record<keyof RequiredHarnessCapabilities, string> = {
  sessionPersistence: "session persistence",
  streaming: "streaming",
  steering: "live steering",
  cancellation: "cancellation",
  tools: "tools",
  mcp: "MCP",
  usage: "usage reporting",
  computerControl: "computer control",
  multiAgent: "multi-agent orchestration",
};

function capabilitySatisfied(capabilities: HarnessCapabilities, key: keyof RequiredHarnessCapabilities, required: unknown): boolean {
  if (required === undefined || required === false) return true;
  if (key === "steering") {
    if (required === "follow-up") return capabilities.steering === "follow-up" || capabilities.steering === "mid-turn";
    return capabilities.steering === "mid-turn";
  }
  if (key === "usage") return capabilities.usage !== "unavailable";
  return capabilities[key as keyof HarnessCapabilities] === true;
}

export class HarnessRegistry {
  private readonly adapters = new Map<string, HarnessAdapter>();

  constructor(adapters: HarnessAdapter[]) {
    for (const adapter of adapters) {
      const id = adapter.descriptor.id;
      if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(id)) throw new Error("Harness adapter has an invalid ID");
      if (this.adapters.has(id)) throw new Error(`Duplicate harness adapter id "${id}"`);
      this.adapters.set(id, adapter);
    }
  }

  ids(): string[] {
    return [...this.adapters.keys()].sort();
  }

  resolve(conversation: Pick<Conversation, "provider" | "harnessId">): HarnessAdapter {
    const id = conversation.harnessId || this.compatibilityId(conversation.provider);
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Harness adapter "${id}" is not registered`);
    return adapter;
  }

  compatibilityId(provider: ProviderId): string {
    const matches = [...this.adapters.values()].filter((adapter) => adapter.descriptor.providerCompatibility.includes(provider));
    if (!matches.length) throw new Error(`Expected a compatibility harness for ${provider}; found 0`);
    const highest = Math.max(...matches.map((adapter) => adapter.descriptor.compatibilityPriority ?? 0));
    const preferred = matches.filter((adapter) => (adapter.descriptor.compatibilityPriority ?? 0) === highest);
    if (preferred.length !== 1) throw new Error(`Expected one preferred compatibility harness for ${provider}; found ${preferred.length}`);
    return preferred[0]!.descriptor.id;
  }

  requireCompatible(id: string, required: RequiredHarnessCapabilities): HarnessAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Harness adapter "${id}" is not registered`);
    const missing = (Object.entries(required) as Array<[keyof RequiredHarnessCapabilities, unknown]>)
      .filter(([key, value]) => !capabilitySatisfied(adapter.descriptor.capabilities, key, value))
      .map(([key]) => CAPABILITY_LABELS[key]);
    if (missing.length) throw new Error(`${id} is incompatible: ${missing.join(", ")}`);
    return adapter;
  }

  async dispatch(
    conversation: Conversation,
    context: ProviderRunContext,
    required: RequiredHarnessCapabilities = {},
  ): Promise<void> {
    const resolved = this.resolve(conversation);
    const adapter = this.requireCompatible(resolved.descriptor.id, required);
    await adapter.run({
      ...context,
      onEvent: async (event) => {
        const enriched = event.type === "final" && !event.runtime
          ? {
              ...event,
              runtime: {
                provider: conversation.provider,
                harnessId: resolved.descriptor.id,
                requestedModel: conversation.model,
                reasoning: conversation.reasoning,
              },
            }
          : event;
        await context.onEvent(validateHarnessEvent(enriched));
      },
    });
  }

  deliverControl(harnessId: string, control: HarnessControl): Promise<HarnessControlResult> {
    const adapter = this.adapters.get(harnessId);
    if (!adapter) return Promise.resolve({ accepted: false, reason: `Harness adapter "${harnessId}" is not registered` });
    return adapter.deliverControl(control);
  }

  async snapshot(settings: ProviderRunContext["settings"], homeDirectory: string): Promise<HarnessRegistryEntry[]> {
    return Promise.all([...this.adapters.values()].map(async (adapter) => ({
      ...structuredClone(adapter.descriptor),
      health: await adapter.health({ settings, homeDirectory }),
    })));
  }

  providerStatuses(snapshot: HarnessRegistryEntry[]): ProviderStatus[] {
    return (["codex", "openrouter", "pi"] as ProviderId[]).map((provider) => {
      const entry = snapshot.find((candidate) => candidate.providerCompatibility.includes(provider));
      if (!entry) return { id: provider, ready: false, label: "Harness missing", source: "Registry", detail: `No harness supports ${provider}.` };
      return { id: provider, ...entry.health };
    });
  }

  async cleanup(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.cleanup()));
  }
}

export function createDefaultHarnessRegistry(homeDirectory: string): HarnessRegistry {
  const sdk = new CodexSdkAdapter();
  return new HarnessRegistry([new CodexAppServerAdapter(undefined, sdk), sdk, new OpenRouterAdapter(homeDirectory), new PiAdapter(homeDirectory)]);
}
