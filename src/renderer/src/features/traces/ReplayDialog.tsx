import type { ReplayMode, ReplayResult } from "../../../../shared/control-plane-contracts";

export function ReplayDialog({ mode, busy, result, onMode, onRun }: {
  mode: ReplayMode;
  busy: boolean;
  result?: ReplayResult;
  onMode(mode: ReplayMode): void;
  onRun(): void;
}) {
  return (
    <section className="quality-card replay-dialog" aria-label="Safe replay controls">
      <header><div><span>Replay boundary</span><h4>Choose what may execute</h4></div><strong className={`replay-boundary ${mode}`}>{mode === "forked" ? "SIDE EFFECTS POSSIBLE" : "NO SIDE EFFECTS"}</strong></header>
      <div className="replay-mode-grid" role="radiogroup" aria-label="Replay mode">
        {(["inspection", "simulated", "forked"] as const).map((value) => (
          <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? "selected" : ""} onClick={() => onMode(value)}>
            <strong>{value}</strong><small>{value === "inspection" ? "Read the trace only" : value === "simulated" ? "Use recorded tool results" : "Run in a disposable worktree"}</small>
          </button>
        ))}
      </div>
      <button className="quality-primary" type="button" disabled={busy || mode === "forked"} onClick={onRun}>{busy ? "Replaying…" : mode === "forked" ? "Fork requires a disposable lease" : `Run ${mode} replay`}</button>
      {result && <p className="quality-evidence">{result.events.length} events · {result.substitutions.length} recorded substitutions · execution {result.executed ? "occurred" : "blocked"}</p>}
    </section>
  );
}
