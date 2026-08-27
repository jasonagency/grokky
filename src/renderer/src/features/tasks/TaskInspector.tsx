import { useState } from "react";
import type { TaskAction, TaskNode } from "../../../../shared/control-plane-contracts";

export function TaskInspector({ task, busy, onAction }: {
  task?: TaskNode;
  busy?: boolean;
  onAction(taskId: string, action: TaskAction): Promise<void> | void;
}) {
  const [message, setMessage] = useState("");
  if (!task) return <aside className="task-inspector empty"><p>Select a task to inspect its assignment, attempts, blockers, and controls.</p></aside>;
  const active = task.status === "leased" || task.status === "running";
  const terminal = task.status === "succeeded" || task.status === "failed" || task.status === "canceled";
  const retryable = (task.status === "failed" || task.status === "canceled") && task.attempts.length < task.maxAttempts;
  return (
    <aside className="task-inspector" aria-label={`Inspect ${task.title}`}>
      <header><span>{task.status}</span><h3>{task.title}</h3><p>{task.description || "No task description"}</p></header>
      <dl>
        <div><dt>Priority</dt><dd>{task.priority}</dd></div>
        <div><dt>Agent</dt><dd>{task.assignment.agentId || "Unassigned"}</dd></div>
        <div><dt>Harness</dt><dd>{task.assignment.harnessId || "Route automatically"}</dd></div>
        <div><dt>Attempts</dt><dd>{task.attempts.length} / {task.maxAttempts}</dd></div>
      </dl>
      {task.blockerChain.length > 0 && <section><h4>Blocker chain</h4><p>{task.blockerChain.join(" → ")}</p></section>}
      {task.checkpoints.at(-1) && <section><h4>Latest checkpoint</h4><p>{task.checkpoints.at(-1)!.cursor}</p></section>}
      {task.outcome && <section><h4>Outcome</h4><p>{task.outcome.summary}</p></section>}
      <div className="task-inspector-actions" aria-label="Task controls">
        <button type="button" disabled={busy || active || terminal} onClick={() => void onAction(task.id, task.status === "paused" ? { type: "resume" } : { type: "pause" })}>{task.status === "paused" ? "Resume" : "Pause"}</button>
        <button type="button" disabled={busy || active || terminal} onClick={() => void onAction(task.id, { type: "cancel" })}>Cancel</button>
        <button type="button" disabled={busy || !retryable} onClick={() => void onAction(task.id, { type: "retry" })}>Retry</button>
        <button type="button" disabled={busy || task.priority >= 100} onClick={() => void onAction(task.id, { type: "reprioritize", priority: task.priority + 1 })}>Raise priority</button>
      </div>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!message.trim()) return;
        void Promise.resolve(onAction(task.id, { type: "message", text: message })).then(() => setMessage(""));
      }}>
        <label htmlFor={`task-message-${task.id}`}>Message this task</label>
        <div><input id={`task-message-${task.id}`} value={message} maxLength={500} onChange={(event) => setMessage(event.target.value)} /><button type="submit" disabled={busy || !message.trim()}>Queue</button></div>
      </form>
    </aside>
  );
}
