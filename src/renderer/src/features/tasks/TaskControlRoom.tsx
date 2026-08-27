import { useState } from "react";
import type { AppSnapshot } from "../../../../shared/contracts";
import { TaskGraphView } from "./TaskGraphView";
import { TaskInspector } from "./TaskInspector";
import { WorkspaceLeasePanel } from "./WorkspaceLeasePanel";

export function TaskControlRoom({ snapshot, onError }: { snapshot: AppSnapshot; onError(error: string): void }) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(snapshot.taskGraph.tasks[0]?.id);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedTask = snapshot.taskGraph.tasks.find((task) => task.id === selectedTaskId) ?? snapshot.taskGraph.tasks[0];

  async function createGoal() {
    if (!title.trim() || !objective.trim()) return;
    setBusy(true);
    try {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const taskId = `task-${suffix}`;
      await window.grokky.createTaskGoal({
        id: `goal-${suffix}`,
        title: title.trim(),
        objective: objective.trim(),
        nodes: [{ id: taskId, title: title.trim(), description: objective.trim(), priority: 0 }],
      });
      setSelectedTaskId(taskId);
      setTitle("");
      setObjective("");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Task goal could not be created");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="task-control-room">
      <div className="settings-intro"><h3>Task graph</h3><p>Durable goals, dependencies, leases, blockers, and attempts, independent from chat history.</p></div>
      <form className="task-goal-form" onSubmit={(event) => { event.preventDefault(); void createGoal(); }}>
        <label>Goal title<input value={title} maxLength={500} placeholder="Ship the next release" onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Objective<input value={objective} maxLength={500} placeholder="What should the team accomplish?" onChange={(event) => setObjective(event.target.value)} /></label>
        <button type="submit" disabled={busy || !title.trim() || !objective.trim()}>{busy ? "Creating…" : "Create goal"}</button>
      </form>
      <div className="task-control-grid">
        <TaskGraphView graph={snapshot.taskGraph} selectedTaskId={selectedTask?.id} onSelect={setSelectedTaskId} />
        <div className="task-side-panel">
          <TaskInspector
            task={selectedTask}
            busy={busy}
            onAction={async (taskId, action) => {
              setBusy(true);
              try {
                await window.grokky.actOnTask(taskId, action);
              } catch (error) {
                onError(error instanceof Error ? error.message : "Task could not be updated");
              } finally {
                setBusy(false);
              }
            }}
          />
          <WorkspaceLeasePanel taskId={selectedTask?.id} state={snapshot.workspaceState} />
        </div>
      </div>
    </div>
  );
}
