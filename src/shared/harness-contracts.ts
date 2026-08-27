import type { ProviderId } from "./contracts";

export type HarnessUsageCapability = "authoritative" | "estimated" | "delayed" | "unavailable";
export type HarnessSteeringCapability = "none" | "follow-up" | "mid-turn";

export interface HarnessCapabilities {
  sessionPersistence: boolean;
  streaming: boolean;
  steering: HarnessSteeringCapability;
  cancellation: boolean;
  tools: boolean;
  mcp: boolean;
  usage: HarnessUsageCapability;
  computerControl: boolean;
  multiAgent: boolean;
}

export interface HarnessModelDescriptor {
  id: string;
  label: string;
  dynamic?: boolean;
}

export interface HarnessDescriptor {
  id: string;
  version: string;
  displayName: string;
  providerCompatibility: ProviderId[];
  models: HarnessModelDescriptor[];
  capabilities: HarnessCapabilities;
}

export interface HarnessHealth {
  ready: boolean;
  label: string;
  source: string;
  detail: string;
}

export interface HarnessRegistryEntry extends HarnessDescriptor {
  health: HarnessHealth;
}

export type RequiredHarnessCapabilities = Partial<Pick<
  HarnessCapabilities,
  "sessionPersistence" | "streaming" | "cancellation" | "tools" | "mcp" | "computerControl" | "multiAgent"
>> & {
  steering?: Exclude<HarnessSteeringCapability, "none">;
  usage?: Exclude<HarnessUsageCapability, "unavailable">;
};

export interface HarnessSessionReference {
  harnessId: string;
  adapterVersion: string;
  nativeSessionId: string;
}

export interface HarnessAttempt {
  id: string;
  harnessId: string;
  adapterVersion: string;
  status: "running" | "completed" | "failed" | "stopped";
  session?: HarnessSessionReference;
  startedAt: number;
  endedAt?: number;
}

export type HarnessControl =
  | { type: "cancel" }
  | { type: "follow-up"; message: string }
  | { type: "steer"; message: string };

export interface HarnessControlResult {
  accepted: boolean;
  reason?: string;
}
