import type { ControlRuntimeSnapshot } from "../../shared/control-plane-contracts";

export interface ControlRuntimeStore {
  readControlRuntime(): Promise<string | null>;
  writeControlRuntime(snapshot: string): Promise<void>;
}

export class ControlRuntimeRepository {
  private value: ControlRuntimeSnapshot = emptyRuntime();
  private initialized = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: ControlRuntimeStore) {}

  initialize(): Promise<void> {
    return this.enqueue(async () => {
      if (this.initialized) return;
      const stored = await this.store.readControlRuntime();
      this.value = stored ? { ...emptyRuntime(), ...JSON.parse(stored) as ControlRuntimeSnapshot } : emptyRuntime();
      this.initialized = true;
    });
  }

  snapshot(): ControlRuntimeSnapshot {
    if (!this.initialized) throw new Error("Control runtime is not initialized");
    return structuredClone(this.value);
  }

  mutate<T>(operation: (value: ControlRuntimeSnapshot) => T): Promise<T> {
    return this.enqueue(async () => {
      if (!this.initialized) throw new Error("Control runtime is not initialized");
      const candidate = structuredClone(this.value);
      const result = operation(candidate);
      candidate.revision += 1;
      await this.store.writeControlRuntime(JSON.stringify(candidate));
      this.value = candidate;
      return result;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function emptyRuntime(): ControlRuntimeSnapshot {
  return { revision: 0, commands: [], notifications: [], budgetDecisions: [], routeDecisions: [], budgetPolicy: { hard: {}, soft: {}, reserveFraction: 0.1 }, routingPolicy: { requiredCapabilities: {}, preferredModels: [] } };
}
