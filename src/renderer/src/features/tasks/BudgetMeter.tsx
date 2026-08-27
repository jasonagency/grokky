import type { BudgetDecision, BudgetPolicy } from "../../../../shared/control-plane-contracts";

export function BudgetMeter({ policy, decisions }: { policy: BudgetPolicy; decisions: BudgetDecision[] }) {
  const latest = decisions.at(-1);
  return (
    <section className="budget-meter" aria-label="Budget status">
      <h4>Budget</h4>
      <div><span>Soft tokens</span><strong>{policy.soft.tokens?.toLocaleString() ?? "Not set"}</strong></div>
      <div><span>Hard tokens</span><strong>{policy.hard.tokens?.toLocaleString() ?? "Not set"}</strong></div>
      <div><span>Reported cost</span><strong>{latest?.metric === "costUsd" && latest.measured !== null && latest.measured !== undefined ? `$${latest.measured.toFixed(4)}` : "Unavailable"}</strong></div>
      {latest && <p className={`budget-${latest.status}`}>{latest.status}: {latest.reason}</p>}
    </section>
  );
}
