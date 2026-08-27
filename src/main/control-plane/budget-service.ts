import type { BudgetDecision, BudgetMeasurements, BudgetMetric, BudgetPolicy, MeasurementQuality } from "../../shared/control-plane-contracts";

const metrics: BudgetMetric[] = ["tokens", "costUsd", "elapsedMs", "concurrency", "retries", "toolRisk"];

function adjusted(value: number, quality: MeasurementQuality, reserveFraction: number): number {
  return quality === "estimated" || quality === "delayed" ? value * (1 + reserveFraction) : value;
}

export class BudgetService {
  evaluate(policy: BudgetPolicy, measurements: BudgetMeasurements, options: { enforceableBoundary: boolean }): BudgetDecision {
    if (!Number.isFinite(policy.reserveFraction) || policy.reserveFraction < 0 || policy.reserveFraction > 1) throw new Error("Budget reserve must be between 0 and 1");
    for (const metric of metrics) {
      const measurement = measurements[metric];
      const hard = policy.hard[metric];
      const soft = policy.soft[metric];
      if (!measurement || measurement.quality === "unavailable" || measurement.value === undefined) {
        if (hard !== undefined || soft !== undefined) return { status: "advisory", metric, measured: null, threshold: hard ?? soft, quality: measurement?.quality ?? "unavailable", enforceability: "advisory", reason: `${metric} is unavailable and cannot be enforced` };
        continue;
      }
      const measured = adjusted(measurement.value, measurement.quality, policy.reserveFraction);
      if (hard !== undefined && measured >= hard) {
        if (measurement.quality === "authoritative" && options.enforceableBoundary) return { status: "blocked", metric, measured, threshold: hard, quality: measurement.quality, enforceability: "hard", reason: `Hard ${metric} ceiling reached before the next enforceable boundary` };
        return { status: "advisory", metric, measured, threshold: hard, quality: measurement.quality, enforceability: "advisory", reason: `${metric} reached the configured ceiling but the current measurement or boundary is not enforceable` };
      }
      if (soft !== undefined && measured >= soft) return { status: "paused", metric, measured, threshold: soft, quality: measurement.quality, enforceability: "soft", reason: `Soft ${metric} threshold reached` };
    }
    return { status: "allowed", enforceability: "hard", reason: "Budgets allow the next operation" };
  }
}
