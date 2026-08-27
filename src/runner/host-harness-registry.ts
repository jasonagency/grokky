import type { RemoteJobRecord } from "../shared/remote-protocol";
import type { HarnessHealth } from "../shared/harness-contracts";

export interface HostHarnessContext { emit(type: "job.output" | "job.approval", payload: unknown): Promise<void>; signal: AbortSignal }
export type HostHarnessHandler = (job: RemoteJobRecord, context: HostHarnessContext) => Promise<unknown>;

export class HostHarnessRegistry {
  private readonly handlers = new Map<string, HostHarnessHandler>();
  private readonly health = new Map<string, HarnessHealth>();
  private cleanupHandler?: () => Promise<void>;
  register(id: string, handler: HostHarnessHandler): void { if (this.handlers.has(id)) throw new Error(`Host harness ${id} is already registered`); this.handlers.set(id, handler); }
  reportReadiness(id: string, health: HarnessHealth): void { this.health.set(id, structuredClone(health)); }
  ids(): string[] { return [...this.handlers.keys()].sort(); }
  readiness(): Array<{ id: string; ready: boolean; label: string; detail: string }> {
    return [...this.health.entries()].map(([id, health]) => ({ id, ready: health.ready, label: health.label, detail: health.detail })).sort((left, right) => left.id.localeCompare(right.id));
  }
  onCleanup(handler: () => Promise<void>): void { this.cleanupHandler = handler; }
  async cleanup(): Promise<void> { await this.cleanupHandler?.(); }
  handler(id: string): HostHarnessHandler { const found = this.handlers.get(id); if (!found) throw new Error(`Host harness ${id} is unavailable`); return found; }
}
