import type { HarnessCapabilities, HarnessRegistryEntry, RequiredHarnessCapabilities } from "../../shared/harness-contracts";
import type { RouteDecision, RoutingPolicy } from "../../shared/control-plane-contracts";

function compatible(capabilities: HarnessCapabilities, required: RequiredHarnessCapabilities): string[] {
  const missing: string[] = [];
  for (const [key, value] of Object.entries(required) as Array<[keyof RequiredHarnessCapabilities, unknown]>) {
    if (value === undefined || value === false) continue;
    if (key === "steering") {
      const satisfied = value === "follow-up" ? capabilities.steering !== "none" : capabilities.steering === "mid-turn";
      if (!satisfied) missing.push("steering");
    } else if (key === "usage") {
      if (capabilities.usage === "unavailable") missing.push("usage");
    } else if (capabilities[key as keyof HarnessCapabilities] !== true) missing.push(key);
  }
  return missing;
}

function cost(entry: HarnessRegistryEntry): number {
  return (entry.estimatedInputCostPerMillion ?? Number.POSITIVE_INFINITY) + (entry.estimatedOutputCostPerMillion ?? Number.POSITIVE_INFINITY);
}

export class PolicyEngine {
  route(entries: HarnessRegistryEntry[], policy: RoutingPolicy): RouteDecision {
    const rejections: RouteDecision["rejections"] = [];
    const candidates = entries.filter((entry) => {
      if (!entry.health.ready) { rejections.push({ harnessId: entry.id, reason: "Harness is not ready" }); return false; }
      if (policy.allowedHarnessIds && !policy.allowedHarnessIds.includes(entry.id)) { rejections.push({ harnessId: entry.id, reason: "Harness is not allowed by policy" }); return false; }
      const missing = compatible(entry.capabilities, policy.requiredCapabilities);
      if (missing.length) { rejections.push({ harnessId: entry.id, reason: `Missing capabilities: ${missing.join(", ")}` }); return false; }
      return true;
    }).sort((left, right) => cost(left) - cost(right) || left.id.localeCompare(right.id));
    const selected = candidates[0];
    if (!selected) return { status: "rejected", reason: "No ready harness satisfies the routing policy", rejections };
    const preferred = policy.preferredModels.find((model) => selected.models.some((entry) => entry.dynamic || entry.id === model));
    const model = preferred ?? selected.models[0]?.id;
    return { status: "selected", harnessId: selected.id, ...(model ? { model } : {}), reason: "Selected the lowest-cost ready compatible route", rejections };
  }
}
