import { useEffect, useState } from "react";
import type { BudgetPolicy, ControlPolicyPatch, RoutingPolicy } from "../../../../shared/control-plane-contracts";

export function PolicyEditor({ budget, routing, busy, onSave }: { budget: BudgetPolicy; routing: RoutingPolicy; busy?: boolean; onSave(patch: ControlPolicyPatch): Promise<void> | void }) {
  const [softTokens, setSoftTokens] = useState(budget.soft.tokens?.toString() ?? "");
  const [hardTokens, setHardTokens] = useState(budget.hard.tokens?.toString() ?? "");
  const [requireTools, setRequireTools] = useState(routing.requiredCapabilities.tools === true);
  useEffect(() => { setSoftTokens(budget.soft.tokens?.toString() ?? ""); setHardTokens(budget.hard.tokens?.toString() ?? ""); }, [budget]);
  return (
    <form className="policy-editor" onSubmit={(event) => {
      event.preventDefault();
      void onSave({
        budgetPolicy: { ...budget, soft: { ...budget.soft, ...(softTokens ? { tokens: Number(softTokens) } : { tokens: undefined }) }, hard: { ...budget.hard, ...(hardTokens ? { tokens: Number(hardTokens) } : { tokens: undefined }) } },
        routingPolicy: { ...routing, requiredCapabilities: { ...routing.requiredCapabilities, tools: requireTools } },
      });
    }}>
      <h4>Policies</h4>
      <div><label>Soft token pause<input type="number" min="1" value={softTokens} onChange={(event) => setSoftTokens(event.target.value)} /></label><label>Hard token stop<input type="number" min="1" value={hardTokens} onChange={(event) => setHardTokens(event.target.value)} /></label></div>
      <label className="policy-checkbox"><input type="checkbox" checked={requireTools} onChange={(event) => setRequireTools(event.target.checked)} /> Require tool support</label>
      <button type="submit" disabled={busy}>Save policy</button>
    </form>
  );
}
