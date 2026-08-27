import type { EvalStateSnapshot } from "../../../../shared/control-plane-contracts";

export function EvalDashboard({ state, onCompare }: { state?: EvalStateSnapshot; onCompare(baselineId: string, candidateId: string): void }) {
  const runs = state?.runs ?? [];
  return (
    <section className="quality-card eval-dashboard" aria-label="Evaluation dashboard">
      <header><div><span>Regression suites</span><h4>Versioned evaluation cases</h4></div><strong>{state?.cases.length ?? 0} cases</strong></header>
      <div className="eval-case-list">
        {state?.cases.map((entry) => {
          const caseRuns = runs.filter((run) => run.caseId === entry.id && run.caseVersion === entry.version);
          return <article key={`${entry.id}:${entry.version}`}><span><strong>{entry.name}</strong><small>v{entry.version} · {entry.verificationRules.length} deterministic checks</small></span><em>{caseRuns.length} runs</em></article>;
        })}
        {state && !state.cases.length && <p>No eval cases yet. Promote a redacted trace to create one.</p>}
      </div>
      {runs.length >= 2 && <button type="button" onClick={() => onCompare(runs.at(-2)!.id, runs.at(-1)!.id)}>Compare latest runs</button>}
    </section>
  );
}
