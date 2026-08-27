import type { EvalCase, EvalGraderResult, EvalMetricSet, TraceBundle } from "../../shared/control-plane-contracts";

export function gradeDeterministic(entry: EvalCase, trace: TraceBundle, metrics: EvalMetricSet): EvalGraderResult[] {
  return entry.verificationRules.map((rule) => {
    if (rule.type === "event-present") {
      const passed = trace.events.some(({ event }) => event.type === rule.eventType);
      return { rule, passed, evidence: passed ? `Observed ${rule.eventType}` : `Missing ${rule.eventType}` };
    }
    if (rule.type === "no-policy-violations") {
      return { rule, passed: metrics.policyViolations === 0, evidence: `${metrics.policyViolations} policy violation(s)` };
    }
    if (rule.type === "max-cost-usd") return { rule, passed: metrics.costUsd <= rule.value, evidence: `$${metrics.costUsd.toFixed(4)} <= $${rule.value.toFixed(4)}` };
    if (rule.type === "max-latency-ms") return { rule, passed: metrics.latencyMs <= rule.value, evidence: `${metrics.latencyMs}ms <= ${rule.value}ms` };
    const passed = trace.events.some((record) => record.links.artifactSha256 === rule.sha256);
    return { rule, passed, evidence: passed ? `Observed artifact ${rule.sha256}` : `Missing artifact ${rule.sha256}` };
  });
}
