import type {
  TaskAction,
  TaskGoal,
  TaskGoalDraft,
  TaskGraphSnapshot,
  TaskNode,
  TaskNodeStatus,
  TaskOutcome,
} from "../../shared/control-plane-contracts";

const TERMINAL = new Set<TaskNodeStatus>(["succeeded", "failed", "canceled"]);
const ACTIVE = new Set<TaskNodeStatus>(["leased", "running"]);
const TASK_CAPABILITIES = new Set([
  "sessionPersistence", "streaming", "steering", "steering:follow-up", "steering:mid-turn",
  "cancellation", "tools", "mcp", "usage", "computerControl", "multiAgent",
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const text = value.trim();
  if (!text || text.length > 500) throw new Error(`${label} must be between 1 and 500 characters`);
  return text;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  if (!/^[a-zA-Z0-9:_-]{1,100}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export function validateTaskId(value: unknown): string {
  return requireId(value, "task ID");
}

function requirePriority(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < -100 || value > 100) throw new Error("Task priority must be an integer from -100 to 100");
  return value;
}

function requireAssignment(assignment: unknown): TaskNode["assignment"] {
  if (!isRecord(assignment)) throw new Error("Invalid task assignment");
  const next = clone(assignment) as TaskNode["assignment"];
  for (const value of [next.agentId, next.harnessId, next.model, next.sourceConversationId, next.targetHostId]) {
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 240)) throw new Error("Invalid task assignment");
  }
  if (next.workspace !== undefined && (typeof next.workspace !== "string" || !next.workspace.trim() || next.workspace.length > 4_000)) throw new Error("Invalid task workspace");
  if (next.workspaceMode !== undefined && next.workspaceMode !== "read" && next.workspaceMode !== "write") throw new Error("Invalid task workspace mode");
  if (next.budgetUsd !== undefined && (typeof next.budgetUsd !== "number" || !Number.isFinite(next.budgetUsd) || next.budgetUsd < 0 || next.budgetUsd > 100_000)) throw new Error("Invalid task budget");
  if (next.approvalPolicy !== undefined && !new Set(["ask", "allow", "deny"]).has(next.approvalPolicy)) throw new Error("Invalid remote approval policy");
  if (next.screenKind !== undefined && next.screenKind !== "browser" && next.screenKind !== "desktop") throw new Error("Invalid remote screen kind");
  if (next.requiredCapabilities && (!Array.isArray(next.requiredCapabilities) || next.requiredCapabilities.length > 50 || next.requiredCapabilities.some((value) => typeof value !== "string" || !TASK_CAPABILITIES.has(value)))) {
    throw new Error("Invalid required task capabilities");
  }
  return next;
}

export function validateTaskAction(value: unknown): TaskAction {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid task action");
  if (value.type === "reprioritize") return { type: value.type, priority: requirePriority(value.priority) };
  if (value.type === "message") return { type: value.type, text: requireText(value.text, "Task message") };
  if (value.type === "assign") return { type: value.type, assignment: requireAssignment(value.assignment) };
  if (value.type === "rewire") {
    if (!Array.isArray(value.dependsOn) || value.dependsOn.length > 100) throw new Error("Invalid task dependencies");
    return { type: value.type, dependsOn: [...new Set(value.dependsOn.map((id) => requireId(id, "dependency ID")))] };
  }
  if (new Set(["pause", "resume", "cancel", "retry"]).has(value.type)) return { type: value.type } as TaskAction;
  throw new Error("Unsupported task action");
}

export function validateTaskGoalDraft(value: unknown): TaskGoalDraft {
  if (!isRecord(value)) throw new Error("Invalid task goal");
  const id = requireId(value.id, "goal ID");
  if (!Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > 500) throw new Error("A task goal requires between 1 and 500 nodes");
  const seen = new Set<string>();
  const nodes = value.nodes.map((node) => {
    if (!isRecord(node)) throw new Error("Invalid task node");
    const nodeId = requireId(node.id, "task ID");
    if (seen.has(nodeId)) throw new Error(`Duplicate task ID "${nodeId}"`);
    seen.add(nodeId);
    const maxAttempts = node.maxAttempts ?? 3;
    if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new Error("Task max attempts must be between 1 and 20");
    return {
      id: nodeId,
      title: requireText(node.title, "Task title"),
      ...(node.description ? { description: requireText(node.description, "Task description") } : {}),
      priority: requirePriority(node.priority ?? 0),
      dependsOn: [...new Set((Array.isArray(node.dependsOn) ? node.dependsOn : []).map((dependency) => requireId(dependency, "dependency ID")))],
      assignment: requireAssignment(node.assignment ?? {}),
      maxAttempts,
    };
  });
  return { id, title: requireText(value.title, "Goal title"), objective: requireText(value.objective, "Goal objective"), nodes };
}

export function validateAcyclicTasks(tasks: Pick<TaskNode, "id" | "dependsOn">[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  const dependencies = new Map(tasks.map((task) => [task.id, task.dependsOn]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Task "${task.id}" depends on unknown task "${dependency}"`);
      if (dependency === task.id) throw new Error(`Task graph contains a cycle at "${task.id}"`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Task graph contains a cycle at "${id}"`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

export class TaskGraph {
  private value: TaskGraphSnapshot;

  constructor(snapshot: TaskGraphSnapshot = { revision: 0, goals: [], tasks: [] }) {
    validateAcyclicTasks(snapshot.tasks);
    this.value = clone(snapshot);
    this.refreshDerivedState();
  }

  static empty(): TaskGraph {
    return new TaskGraph();
  }

  snapshot(): TaskGraphSnapshot {
    return clone(this.value);
  }

  task(taskId: string): TaskNode {
    const task = this.value.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Task "${taskId}" was not found`);
    return clone(task);
  }

  addGoal(input: TaskGoalDraft, now: number): TaskGoal {
    const draft = validateTaskGoalDraft(input);
    if (this.value.goals.some((goal) => goal.id === draft.id)) throw new Error(`Goal "${draft.id}" already exists`);
    const existingIds = new Set(this.value.tasks.map((task) => task.id));
    if (draft.nodes.some((node) => existingIds.has(node.id))) throw new Error("Task IDs must be unique across goals");
    const goalIds = new Set(draft.nodes.map((node) => node.id));
    if (draft.nodes.some((node) => (node.dependsOn ?? []).some((dependency) => !goalIds.has(dependency)))) {
      throw new Error("Task dependencies must belong to the same goal");
    }
    const candidateTasks: TaskNode[] = draft.nodes.map((node) => ({
      id: node.id,
      goalId: draft.id,
      title: node.title,
      description: node.description ?? "",
      status: node.dependsOn?.length ? "blocked" : "queued",
      priority: node.priority ?? 0,
      dependsOn: node.dependsOn ?? [],
      blockerChain: [...(node.dependsOn ?? [])],
      assignment: node.assignment ?? {},
      maxAttempts: node.maxAttempts ?? 3,
      attempts: [],
      checkpoints: [],
      messages: [],
      createdAt: now,
      updatedAt: now,
    }));
    validateAcyclicTasks(candidateTasks);
    const goal: TaskGoal = { id: draft.id, title: draft.title, objective: draft.objective, status: "active", createdAt: now, updatedAt: now };
    this.value.goals.push(goal);
    this.value.tasks.push(...candidateTasks);
    this.bump();
    return clone(goal);
  }

  readyTasks(): TaskNode[] {
    return this.value.tasks
      .filter((task) => task.status === "queued")
      .sort((left, right) => right.priority - left.priority || left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(clone);
  }

  applyAction(taskId: string, rawAction: TaskAction, now: number): void {
    const action = validateTaskAction(rawAction);
    const task = this.requireMutableTask(taskId);
    if (action.type === "reprioritize") task.priority = action.priority;
    else if (action.type === "message") task.messages.push({ id: `message:${task.id}:${now}:${task.messages.length + 1}`, text: action.text, createdAt: now, delivery: "queued" });
    else if (action.type === "assign") task.assignment = action.assignment;
    else if (action.type === "pause") {
      if (ACTIVE.has(task.status)) throw new Error("Active work must be interrupted before it can be paused");
      if (TERMINAL.has(task.status)) throw new Error("Terminal work cannot be paused");
      task.status = "paused";
    } else if (action.type === "resume") {
      if (task.status !== "paused") throw new Error("Only paused work can be resumed");
      task.status = "blocked";
    } else if (action.type === "cancel") {
      if (ACTIVE.has(task.status)) throw new Error("Active work must be interrupted before it can be canceled");
      if (task.status === "succeeded") throw new Error("Succeeded work cannot be canceled");
      task.status = "canceled";
      task.outcome = { summary: "Canceled by operator", completedAt: now };
    } else if (action.type === "retry") {
      if (!new Set<TaskNodeStatus>(["failed", "canceled"]).has(task.status)) throw new Error("Only failed or canceled work can be retried");
      if (task.attempts.length >= task.maxAttempts) throw new Error("Task has reached its attempt limit");
      task.status = "blocked";
      task.outcome = undefined;
    } else if (action.type === "rewire") {
      if (ACTIVE.has(task.status)) throw new Error("Active work cannot be rewired");
      if (task.status === "succeeded") throw new Error("Succeeded work cannot be rewired");
      const byId = new Map(this.value.tasks.map((candidate) => [candidate.id, candidate]));
      if (action.dependsOn.some((dependencyId) => byId.get(dependencyId)?.goalId !== task.goalId)) {
        throw new Error("Task dependencies must belong to the same goal");
      }
      const previous = task.dependsOn;
      task.dependsOn = action.dependsOn;
      try {
        validateAcyclicTasks(this.value.tasks);
      } catch (error) {
        task.dependsOn = previous;
        throw error;
      }
    }
    task.updatedAt = now;
    this.refreshDerivedState();
    this.bump();
  }

  markFailed(taskId: string, outcome: TaskOutcome, now: number): void {
    const task = this.requireMutableTask(taskId);
    task.status = "failed";
    task.outcome = clone(outcome);
    task.lease = undefined;
    task.updatedAt = now;
    this.refreshDerivedState();
    this.bump();
  }

  mutate(mutator: (snapshot: TaskGraphSnapshot) => void): void {
    mutator(this.value);
    validateAcyclicTasks(this.value.tasks);
    this.refreshDerivedState();
    this.bump();
  }

  private requireMutableTask(taskId: string): TaskNode {
    const task = this.value.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Task "${taskId}" was not found`);
    return task;
  }

  private refreshDerivedState(): void {
    const byId = new Map(this.value.tasks.map((task) => [task.id, task]));
    const blockersFor = (task: TaskNode, seen = new Set<string>()): string[] => {
      const blockers: string[] = [];
      for (const dependencyId of task.dependsOn) {
        if (seen.has(dependencyId)) continue;
        seen.add(dependencyId);
        const dependency = byId.get(dependencyId);
        if (!dependency || dependency.status === "succeeded") continue;
        if (dependency.status === "failed" || dependency.status === "canceled") blockers.push(dependencyId);
        blockers.push(...blockersFor(dependency, seen));
        if (!blockers.includes(dependencyId)) blockers.push(dependencyId);
      }
      return [...new Set(blockers)];
    };
    for (const task of this.value.tasks) {
      task.blockerChain = blockersFor(task);
      if (TERMINAL.has(task.status) || ACTIVE.has(task.status) || task.status === "paused") continue;
      task.status = task.dependsOn.every((dependency) => byId.get(dependency)?.status === "succeeded") ? "queued" : "blocked";
    }
    for (const goal of this.value.goals) {
      const tasks = this.value.tasks.filter((task) => task.goalId === goal.id);
      if (tasks.length && tasks.every((task) => task.status === "succeeded")) goal.status = "succeeded";
      else if (tasks.some((task) => task.status === "failed") && tasks.every((task) => TERMINAL.has(task.status) || task.status === "blocked")) goal.status = "failed";
      else if (tasks.every((task) => task.status === "canceled")) goal.status = "canceled";
      else if (goal.status !== "paused") goal.status = "active";
    }
  }

  private bump(): void {
    this.value.revision += 1;
  }
}
