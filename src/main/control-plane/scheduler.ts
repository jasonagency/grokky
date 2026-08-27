import type {
  TaskAction,
  TaskCheckpoint,
  TaskGoalDraft,
  TaskGraphSnapshot,
  TaskLeaseClaim,
  TaskOutcome,
} from "../../shared/control-plane-contracts";
import { TaskGraph } from "./task-graph";

export interface TaskGraphStore {
  readTaskGraph(): Promise<string | null>;
  writeTaskGraph(snapshot: string): Promise<void>;
}

export interface TaskSchedulerOptions {
  concurrency: number;
  leaseDurationMs: number;
  now?: () => number;
  id?: (prefix: string) => string;
}

export type TaskExecutor = (claim: TaskLeaseClaim) => Promise<Omit<TaskOutcome, "completedAt"> & { settledExternally?: boolean }>;

export interface TaskDispatchResult {
  taskId: string;
  status: "succeeded" | "failed" | "detached";
  error?: string;
}

export class TaskExecutionDetachedError extends Error {
  constructor() {
    super("Remote task monitor detached while host ownership remains active");
    this.name = "TaskExecutionDetachedError";
  }
}

function defaultId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export class TaskScheduler {
  private graph = TaskGraph.empty();
  private initialized = false;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly id: (prefix: string) => string;

  constructor(private readonly store: TaskGraphStore, private readonly options: TaskSchedulerOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 100) throw new Error("Scheduler concurrency must be between 1 and 100");
    if (!Number.isFinite(options.leaseDurationMs) || options.leaseDurationMs < 1_000 && !options.now) {
      throw new Error("Production leases must last at least one second");
    }
    this.now = options.now ?? Date.now;
    this.id = options.id ?? defaultId;
  }

  initialize(): Promise<void> {
    return this.enqueue(async () => {
      const stored = await this.store.readTaskGraph();
      this.graph = stored ? new TaskGraph(JSON.parse(stored) as TaskGraphSnapshot) : TaskGraph.empty();
      this.initialized = true;
    });
  }

  snapshot(): TaskGraphSnapshot {
    this.requireInitialized();
    return this.graph.snapshot();
  }

  createGoal(draft: TaskGoalDraft): Promise<void> {
    return this.enqueue(async () => {
      this.requireInitialized();
      const candidate = new TaskGraph(this.graph.snapshot());
      candidate.addGoal(draft, this.now());
      await this.commitCandidate(candidate);
    });
  }

  applyAction(taskId: string, action: TaskAction): Promise<void> {
    return this.enqueue(async () => {
      this.requireInitialized();
      const candidate = new TaskGraph(this.graph.snapshot());
      candidate.applyAction(taskId, action, this.now());
      await this.commitCandidate(candidate);
    });
  }

  claimReady(): Promise<TaskLeaseClaim[]> {
    return this.enqueue(() => this.claimReadyUnlocked());
  }

  private async claimReadyUnlocked(): Promise<TaskLeaseClaim[]> {
    this.requireInitialized();
    await this.reconcileExpiredLeasesUnlocked();
    const snapshot = this.graph.snapshot();
    const active = snapshot.tasks.filter((task) => task.status === "leased" || task.status === "running").length;
    const capacity = Math.max(0, this.options.concurrency - active);
    const ready = this.graph.readyTasks().slice(0, capacity);
    if (!ready.length) return [];
    const now = this.now();
    const leaseByTask = new Map<string, TaskLeaseClaim>();
    const candidate = new TaskGraph(snapshot);
    candidate.mutate((value) => {
      for (const readyTask of ready) {
        const task = value.tasks.find((candidate) => candidate.id === readyTask.id)!;
        const attemptId = this.id("attempt");
        const leaseId = this.id("lease");
        const attempt = { id: attemptId, taskId: task.id, number: task.attempts.length + 1, status: "leased" as const, startedAt: now };
        const lease = {
          id: leaseId,
          taskId: task.id,
          attemptId,
          idempotencyKey: `${task.id}:attempt:${attempt.number}`,
          acquiredAt: now,
          heartbeatAt: now,
          expiresAt: now + this.options.leaseDurationMs,
        };
        task.attempts.push(attempt);
        task.lease = lease;
        task.status = "leased";
        task.updatedAt = now;
        leaseByTask.set(task.id, {
          task: structuredClone(task),
          lease: structuredClone(lease),
          ...(task.checkpoints.at(-1)?.recoverable ? { checkpoint: structuredClone(task.checkpoints.at(-1)!) } : {}),
        });
      }
    });
    await this.commitCandidate(candidate);
    return ready.map((task) => leaseByTask.get(task.id)!);
  }

  async dispatchReady(executor: TaskExecutor): Promise<TaskDispatchResult[]> {
    const claims = await this.claimReady();
    return Promise.all(claims.map(async (claim): Promise<TaskDispatchResult> => {
      try {
        await this.start(claim.task.id, claim.lease.id);
        const outcome = await executor(claim);
        if (!outcome.settledExternally) await this.complete(claim.task.id, claim.lease.id, outcome);
        return { taskId: claim.task.id, status: "succeeded" };
      } catch (error) {
        if (error instanceof TaskExecutionDetachedError) return { taskId: claim.task.id, status: "detached" };
        const detail = error instanceof Error ? error.message : "Task executor failed";
        try {
          await this.fail(claim.task.id, claim.lease.id, detail);
        } catch {
          // A fenced or externally reconciled lease must not be mutated by this stale executor.
          try {
            await this.reconcileExpiredLeases();
          } catch {
            // Preserve the executor result if recovery persistence is temporarily unavailable.
          }
        }
        return { taskId: claim.task.id, status: "failed", error: detail };
      }
    }));
  }

  async start(taskId: string, leaseId: string): Promise<void> {
    await this.enqueue(() => this.updateLeasedTask(taskId, leaseId, (task, now) => {
      task.status = "running";
      const attempt = task.attempts.find((candidate) => candidate.id === task.lease?.attemptId);
      if (!attempt) throw new Error("Task lease does not reference a valid attempt");
      attempt.status = "running";
      task.updatedAt = now;
    }));
  }

  async heartbeat(taskId: string, leaseId: string): Promise<void> {
    await this.enqueue(() => this.updateLeasedTask(taskId, leaseId, (task, now) => {
      task.lease!.heartbeatAt = now;
      task.lease!.expiresAt = now + this.options.leaseDurationMs;
      task.updatedAt = now;
    }));
  }

  async checkpoint(taskId: string, leaseId: string, value: { cursor: string; recoverable: boolean }): Promise<void> {
    const cursor = value.cursor.trim();
    if (!cursor || cursor.length > 2_000) throw new Error("Checkpoint cursor must be between 1 and 2,000 characters");
    await this.enqueue(() => this.updateLeasedTask(taskId, leaseId, (task, now) => {
      const checkpoint: TaskCheckpoint = {
        id: this.id("checkpoint"),
        taskId,
        attemptId: task.lease!.attemptId,
        cursor,
        recoverable: value.recoverable,
        createdAt: now,
      };
      task.checkpoints.push(checkpoint);
      task.updatedAt = now;
    }));
  }

  async checkpointRemote(taskId: string, attemptId: string, cursor: string): Promise<void> {
    const value = cursor.trim(); if (!value.startsWith("remote:") || value.length > 2_000) throw new Error("Remote checkpoint cursor is invalid");
    await this.enqueue(async () => {
      this.requireInitialized(); const now = this.now(); const candidate = new TaskGraph(this.graph.snapshot());
      candidate.mutate((snapshot) => {
        const task = snapshot.tasks.find((entry) => entry.id === taskId);
        if (!task?.lease || task.lease.attemptId !== attemptId || !task.checkpoints.at(-1)?.cursor.startsWith("remote:")) throw new Error("Remote task ownership is stale or missing");
        task.checkpoints.push({ id: this.id("checkpoint"), taskId, attemptId, cursor: value, recoverable: true, createdAt: now }); task.checkpoints = task.checkpoints.slice(-500); task.updatedAt = now;
      });
      await this.commitCandidate(candidate);
    });
  }

  async interrupt(taskId: string, leaseId: string, status: "paused" | "canceled"): Promise<void> {
    await this.enqueue(() => this.updateLeasedTask(taskId, leaseId, (task, now) => {
      const attempt = task.attempts.find((candidate) => candidate.id === task.lease!.attemptId);
      if (!attempt) throw new Error("Task lease does not reference a valid attempt");
      attempt.status = "canceled";
      attempt.completedAt = now;
      task.status = status;
      task.outcome = status === "canceled" ? { summary: "Canceled by operator", completedAt: now } : undefined;
      task.lease = undefined;
      task.updatedAt = now;
    }));
  }

  async complete(taskId: string, leaseId: string, outcome: Omit<TaskOutcome, "completedAt">): Promise<void> {
    const summary = outcome.summary.trim();
    if (!summary || summary.length > 4_000) throw new Error("Task outcome summary must be between 1 and 4,000 characters");
    await this.enqueue(() => this.updateLeasedTask(taskId, leaseId, (task, now) => {
      const attempt = task.attempts.find((candidate) => candidate.id === task.lease!.attemptId)!;
      attempt.status = "succeeded";
      attempt.completedAt = now;
      task.status = "succeeded";
      task.outcome = { ...structuredClone(outcome), summary, completedAt: now };
      task.lease = undefined;
      task.updatedAt = now;
    }));
  }

  async fail(taskId: string, leaseId: string, error: string): Promise<void> {
    const detail = error.trim();
    if (!detail || detail.length > 4_000) throw new Error("Task failure must be between 1 and 4,000 characters");
    await this.enqueue(() => this.updateLeasedTask(taskId, leaseId, (task, now) => {
      const attempt = task.attempts.find((candidate) => candidate.id === task.lease!.attemptId)!;
      attempt.status = "failed";
      attempt.completedAt = now;
      attempt.error = detail;
      task.status = "failed";
      task.outcome = { summary: detail, completedAt: now };
      task.lease = undefined;
      task.updatedAt = now;
    }));
  }

  async completeRemote(taskId: string, attemptId: string, outcome: Omit<TaskOutcome, "completedAt">): Promise<void> {
    const summary = outcome.summary.trim();
    if (!summary || summary.length > 4_000) throw new Error("Task outcome summary must be between 1 and 4,000 characters");
    await this.settleRemote(taskId, attemptId, (task, attempt, now) => {
      attempt.status = "succeeded";
      attempt.completedAt = now;
      task.status = "succeeded";
      task.outcome = { ...structuredClone(outcome), summary, completedAt: now };
    });
  }

  async failRemote(taskId: string, attemptId: string, error: string): Promise<void> {
    const detail = error.trim();
    if (!detail || detail.length > 4_000) throw new Error("Task failure must be between 1 and 4,000 characters");
    await this.settleRemote(taskId, attemptId, (task, attempt, now) => {
      attempt.status = "failed";
      attempt.completedAt = now;
      attempt.error = detail;
      task.status = "failed";
      task.outcome = { summary: detail, completedAt: now };
    });
  }

  reconcileExpiredLeases(): Promise<string[]> {
    return this.enqueue(() => this.reconcileExpiredLeasesUnlocked());
  }

  private async reconcileExpiredLeasesUnlocked(): Promise<string[]> {
    this.requireInitialized();
    const now = this.now();
    const snapshot = this.graph.snapshot();
    const expiredIds = snapshot.tasks
      .filter((task) => (task.status === "leased" || task.status === "running") && task.lease && task.lease.expiresAt <= now && !task.checkpoints.at(-1)?.cursor.startsWith("remote:"))
      .map((task) => task.id);
    if (!expiredIds.length) return [];
    const candidate = new TaskGraph(snapshot);
    candidate.mutate((value) => {
      for (const taskId of expiredIds) {
        const task = value.tasks.find((candidate) => candidate.id === taskId)!;
        const lease = task.lease;
        if (!lease || lease.expiresAt > now) continue;
        const attempt = task.attempts.find((candidate) => candidate.id === lease.attemptId);
        if (attempt) {
          attempt.status = "interrupted";
          attempt.completedAt = now;
          attempt.recovery = "expired-lease";
        }
        task.lease = undefined;
        const checkpoint = task.checkpoints.at(-1);
        if (checkpoint?.recoverable && task.attempts.length < task.maxAttempts) {
          task.status = "blocked";
          task.outcome = undefined;
        } else {
          task.status = "failed";
          task.outcome = { summary: "Lease expired without a recoverable checkpoint", completedAt: now };
        }
        task.updatedAt = now;
      }
    });
    await this.commitCandidate(candidate);
    return expiredIds;
  }

  private async updateLeasedTask(taskId: string, leaseId: string, update: (task: TaskGraphSnapshot["tasks"][number], now: number) => void): Promise<void> {
    this.requireInitialized();
    const now = this.now();
    const candidate = new TaskGraph(this.graph.snapshot());
    candidate.mutate((value) => {
      const task = value.tasks.find((entry) => entry.id === taskId);
      if (!task) throw new Error(`Task "${taskId}" was not found`);
      if (!task.lease || task.lease.id !== leaseId) throw new Error("Task lease is stale or does not match");
      if (task.lease.expiresAt <= now) throw new Error("Task lease has expired");
      update(task, now);
    });
    await this.commitCandidate(candidate);
  }

  private async settleRemote(
    taskId: string,
    attemptId: string,
    update: (task: TaskGraphSnapshot["tasks"][number], attempt: TaskGraphSnapshot["tasks"][number]["attempts"][number], now: number) => void,
  ): Promise<void> {
    await this.enqueue(async () => {
      this.requireInitialized();
      const now = this.now();
      const candidate = new TaskGraph(this.graph.snapshot());
      candidate.mutate((value) => {
        const task = value.tasks.find((entry) => entry.id === taskId);
        if (!task || !task.lease || task.lease.attemptId !== attemptId || !task.checkpoints.at(-1)?.cursor.startsWith("remote:")) throw new Error("Remote task ownership is stale or missing");
        const attempt = task.attempts.find((entry) => entry.id === attemptId);
        if (!attempt) throw new Error("Remote task attempt was not found");
        update(task, attempt, now);
        task.lease = undefined;
        task.updatedAt = now;
      });
      await this.commitCandidate(candidate);
    });
  }

  private async commitCandidate(candidate: TaskGraph): Promise<void> {
    await this.store.writeTaskGraph(JSON.stringify(candidate.snapshot()));
    this.graph = candidate;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("Task scheduler is not initialized");
  }
}
