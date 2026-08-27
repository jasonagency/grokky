import type { TaskGraphSnapshot, TaskNodeStatus } from "../../../../shared/control-plane-contracts";
import { layoutTaskGraph } from "./task-layout";

const STATUS_LABELS: Record<TaskNodeStatus, string> = {
  blocked: "Blocked",
  queued: "Queued",
  leased: "Leased",
  running: "Running",
  paused: "Paused",
  succeeded: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
};

export function TaskGraphView({ graph, selectedTaskId, onSelect }: {
  graph: TaskGraphSnapshot;
  selectedTaskId?: string;
  onSelect(taskId: string): void;
}) {
  const nodes = layoutTaskGraph(graph);
  return (
    <section className="task-graph-view" aria-label="Task graph and queue">
      <header className="task-graph-summary">
        <span><strong>{graph.tasks.filter((task) => task.status === "running" || task.status === "leased").length}</strong> active</span>
        <span><strong>{graph.tasks.filter((task) => task.status === "queued").length}</strong> queued</span>
        <span><strong>{graph.tasks.filter((task) => task.status === "blocked").length}</strong> blocked</span>
      </header>
      <div className="task-graph-columns" role="list">
        {nodes.map(({ task, depth, dependencyTitles }) => {
          const attempts = task.attempts.length;
          const needsAttention = task.status === "failed" || task.attempts.some((attempt) => attempt.status === "failed" || attempt.status === "interrupted");
          return (
            <div
              className="task-node-item"
              key={task.id}
              role="listitem"
              style={{ "--task-depth": depth } as React.CSSProperties}
            >
              <button
                className={`task-node-card status-${task.status}${selectedTaskId === task.id ? " selected" : ""}`}
                type="button"
                aria-current={selectedTaskId === task.id ? "true" : undefined}
                aria-label={`${task.title}, ${STATUS_LABELS[task.status]}, priority ${task.priority}`}
                onClick={() => onSelect(task.id)}
              >
                <span className="task-node-kicker"><i aria-hidden="true" />{STATUS_LABELS[task.status]} · P{task.priority}</span>
                <strong>{task.title}</strong>
                {dependencyTitles.length > 0 && <small>Depends on {dependencyTitles.join(", ")}</small>}
                {task.blockerChain.length > 0 && <small>Blocked by {task.blockerChain.join(" → ")}</small>}
                <span className="task-node-meta">
                  <span>{attempts} {attempts === 1 ? "attempt" : "attempts"}</span>
                  {task.assignment.agentId && <span>{task.assignment.agentId}</span>}
                  {needsAttention && <b>Needs attention</b>}
                </span>
              </button>
            </div>
          );
        })}
        {!nodes.length && <div className="task-graph-empty">No task graphs yet. Create a goal to start orchestrating work.</div>}
      </div>
    </section>
  );
}
