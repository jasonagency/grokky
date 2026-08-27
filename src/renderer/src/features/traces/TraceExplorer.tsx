import type { TraceBundle, TraceQuery } from "../../../../shared/control-plane-contracts";

export function TraceExplorer({ trace, query, busy, onQuery, onRefresh, onPromote }: {
  trace?: TraceBundle;
  query: TraceQuery;
  busy: boolean;
  onQuery(query: TraceQuery): void;
  onRefresh(): void;
  onPromote(): void;
}) {
  return (
    <section className="quality-card trace-explorer" aria-label="Trace explorer">
      <header><div><span>Event evidence</span><h4>Exact execution timeline</h4></div><button type="button" onClick={onRefresh} disabled={busy}>{busy ? "Loading…" : "Refresh"}</button></header>
      <div className="trace-filters">
        <label><span>Run</span><input value={query.runId ?? ""} placeholder="run ID" onChange={(event) => onQuery({ ...query, runId: event.target.value || undefined })} /></label>
        <label><span>Task</span><input value={query.taskId ?? ""} placeholder="task ID" onChange={(event) => onQuery({ ...query, taskId: event.target.value || undefined })} /></label>
        <label><span>Harness</span><input value={query.harnessId ?? ""} placeholder="codex, pi…" onChange={(event) => onQuery({ ...query, harnessId: event.target.value || undefined })} /></label>
        <label><span>Tool</span><input value={query.tool ?? ""} placeholder="tool name" onChange={(event) => onQuery({ ...query, tool: event.target.value || undefined })} /></label>
      </div>
      <ol className="trace-timeline">
        {trace?.events.map((record) => (
          <li key={record.event.id}>
            <span className="trace-ordinal">{String(record.ordinal + 1).padStart(3, "0")}</span>
            <span><strong>{record.event.type}</strong><small>{record.event.source} · {new Date(record.event.timestamp).toLocaleString()}</small></span>
            <code>{record.links.taskId ?? record.links.runId ?? record.event.aggregateId}</code>
          </li>
        ))}
        {trace && !trace.events.length && <li className="trace-empty">No events match this trace query.</li>}
      </ol>
      <footer><small>{trace?.events.length ?? 0} ordered events</small><button type="button" disabled={!trace?.events.length} onClick={onPromote}>Promote to eval case</button></footer>
    </section>
  );
}
