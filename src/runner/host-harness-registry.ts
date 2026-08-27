import type { RemoteJobRecord } from "../shared/remote-protocol";

export interface HostHarnessContext { emit(type: "job.output" | "job.approval", payload: unknown): Promise<void>; signal: AbortSignal }
export type HostHarnessHandler = (job: RemoteJobRecord, context: HostHarnessContext) => Promise<unknown>;

export class HostHarnessRegistry {
  private readonly handlers = new Map<string, HostHarnessHandler>();
  register(id: string, handler: HostHarnessHandler): void { if (this.handlers.has(id)) throw new Error(`Host harness ${id} is already registered`); this.handlers.set(id, handler); }
  ids(): string[] { return [...this.handlers.keys()].sort(); }
  handler(id: string): HostHarnessHandler { const found = this.handlers.get(id); if (!found) throw new Error(`Host harness ${id} is unavailable`); return found; }
}
