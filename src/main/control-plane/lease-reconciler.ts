import type { TaskScheduler } from "./scheduler";

export class LeaseReconciler {
  constructor(private readonly scheduler: TaskScheduler) {}

  reconcileExpired(): Promise<string[]> {
    return this.scheduler.reconcileExpiredLeases();
  }
}
