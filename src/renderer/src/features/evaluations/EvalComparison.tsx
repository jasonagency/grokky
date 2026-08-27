import type { EvalComparisonResult } from "../../../../shared/control-plane-contracts";

function signed(value: number, suffix = ""): string { return `${value > 0 ? "+" : ""}${value}${suffix}`; }

export function EvalComparison({ comparison }: { comparison?: EvalComparisonResult }) {
  if (!comparison) return <section className="quality-card eval-comparison" aria-label="Evaluation comparison"><p>Select two runs to compare deterministic outcomes.</p></section>;
  return (
    <section className="quality-card eval-comparison" aria-label="Evaluation comparison">
      <header><div><span>Run delta</span><h4>{comparison.deterministicRegression ? "Regression detected" : "No deterministic regression"}</h4></div></header>
      <div className="eval-deltas">
        <span><strong>{signed(comparison.delta.costUsd, " USD")}</strong><small>cost</small></span>
        <span><strong>{signed(comparison.delta.latencyMs, " ms")}</strong><small>latency</small></span>
        <span><strong>{signed(comparison.delta.toolCount)}</strong><small>tools</small></span>
        <span><strong>{signed(comparison.delta.policyViolations)}</strong><small>violations</small></span>
      </div>
    </section>
  );
}
