import type { WorkspaceStateSnapshot } from "../../../../shared/control-plane-contracts";

export function WorkspaceLeasePanel({ taskId, state, busy, onIntegrate }: { taskId?: string; state?: WorkspaceStateSnapshot; busy?: boolean; onIntegrate?(leaseId: string, targetRef: string): void }) {
  if (!taskId) return null;
  const leases = state?.leases.filter((lease) => lease.taskId === taskId) ?? [];
  const integrations = state?.integrations.filter((integration) => integration.taskId === taskId) ?? [];
  const lease = leases.at(-1);
  const integration = integrations.at(-1);
  return (
    <aside className="workspace-lease-panel" aria-label="Workspace lease">
      <h4>Workspace isolation</h4>
      {!lease && <p>No workspace has been leased for this task.</p>}
      {lease && <>
        <strong>{lease.kind === "git" ? "Isolated Git worktree" : "Exclusive directory"}</strong>
        <dl>
          <div><dt>Status</dt><dd>{lease.status}</dd></div>
          <div><dt>Holder</dt><dd>{lease.holderId}</dd></div>
          <div><dt>Access</dt><dd>{lease.writable ? "One writer" : "Read only"}</dd></div>
          {lease.branch && <div><dt>Branch</dt><dd>{lease.branch}</dd></div>}
        </dl>
        {lease.recoveryReason && <p className="workspace-recovery">{lease.recoveryReason}</p>}
        {lease.kind === "git" && lease.status === "completed" && lease.baseCommit && onIntegrate && <button type="button" disabled={busy} onClick={() => onIntegrate(lease.id, lease.baseCommit!)}>{busy ? "Integrating…" : "Integrate verified branch"}</button>}
      </>}
      {integration && <p>Integration: <strong>{integration.status}</strong>{integration.conflictFiles?.length ? ` (${integration.conflictFiles.join(", ")})` : ""}</p>}
      {integration?.cleanupWarning && <p className="workspace-recovery">Cleanup needs attention: {integration.cleanupWarning}</p>}
    </aside>
  );
}
