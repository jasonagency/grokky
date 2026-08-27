import type { ScreenLease } from "../../../../shared/remote-protocol";

export function TakeoverControls({ lease, busy, onTakeover, onReturn, onLock }: { lease: ScreenLease; busy: boolean; onTakeover(): void; onReturn(): void; onLock(): void }) {
  return <div className="takeover-controls" aria-label={`Controls for ${lease.agentId}`}>
    {lease.controller === "agent" && <button type="button" disabled={busy} onClick={onTakeover}>Take over</button>}
    {(lease.controller === "operator" || lease.controller === "locked") && <button type="button" disabled={busy} onClick={onReturn}>{lease.controller === "locked" ? "Resume agent" : "Return control"}</button>}
    <button type="button" disabled={busy || lease.controller === "locked"} onClick={onLock}>Stop input</button>
  </div>;
}
