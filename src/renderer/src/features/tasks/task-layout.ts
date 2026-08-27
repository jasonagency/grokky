import type { TaskGraphSnapshot, TaskNode } from "../../../../shared/control-plane-contracts";

export interface TaskLayoutNode {
  task: TaskNode;
  depth: number;
  dependencyTitles: string[];
}

export function layoutTaskGraph(graph: TaskGraphSnapshot): TaskLayoutNode[] {
  const byId = new Map(graph.tasks.map((task) => [task.id, task]));
  const depthCache = new Map<string, number>();
  const depthOf = (task: TaskNode): number => {
    const cached = depthCache.get(task.id);
    if (cached !== undefined) return cached;
    const depth = task.dependsOn.length ? 1 + Math.max(...task.dependsOn.map((id) => depthOf(byId.get(id)!))) : 0;
    depthCache.set(task.id, depth);
    return depth;
  };
  return graph.tasks
    .map((task) => ({
      task,
      depth: depthOf(task),
      dependencyTitles: task.dependsOn.map((id) => byId.get(id)?.title ?? id),
    }))
    .sort((left, right) => left.depth - right.depth || right.task.priority - left.task.priority || left.task.id.localeCompare(right.task.id));
}
