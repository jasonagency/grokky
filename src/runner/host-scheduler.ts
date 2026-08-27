import type { RemoteJobRecord } from "../shared/remote-protocol";
import type { HostHarnessRegistry } from "./host-harness-registry";
import type { HostStore } from "./host-store";

export interface HostEventSink { emit(job: RemoteJobRecord, type: "job.running" | "job.output" | "job.approval" | "job.completed" | "job.failed" | "job.canceled" | "diagnostic", payload: unknown): Promise<void> }

export class HostScheduler {
  private controllers = new Map<string, AbortController>();
  private approvalResolvers = new Map<string, (allowed: boolean) => void>();
  constructor(private readonly store: HostStore, private readonly registry: HostHarnessRegistry, private readonly sink: HostEventSink, private readonly now = Date.now) {}

  recover(): void {
    for (const job of this.store.snapshot().jobs) {
      if (job.status === "queued") void this.start(job.id);
      else if (job.status === "running" || job.status === "waiting-approval") void this.interrupt(job.id, `Host restarted while the harness was ${job.status === "waiting-approval" ? "waiting for approval" : "running"}`);
    }
  }

  async start(jobId: string): Promise<void> {
    if (this.controllers.has(jobId)) return;
    const job = this.store.snapshot().jobs.find((item) => item.id === jobId);
    if (!job || job.status !== "queued") return;
    const controller = new AbortController(); this.controllers.set(jobId, controller);
    await this.transition(jobId, "running");
    const running = this.store.snapshot().jobs.find((item) => item.id === jobId)!;
    await this.sink.emit(running, "job.running", {});
    try {
      const output = await this.registry.handler(running.harnessId)(running, { signal: controller.signal, emit: async (type, payload) => {
        if (type === "job.approval") {
          await this.transition(jobId, "waiting-approval");
          await this.sink.emit(this.store.snapshot().jobs.find((item) => item.id === jobId)!, type, payload);
          const allowed = await new Promise<boolean>((resolve) => this.approvalResolvers.set(jobId, resolve));
          this.approvalResolvers.delete(jobId);
          if (!allowed) throw new Error("Operator denied the remote approval");
          await this.transition(jobId, "running");
          return;
        }
        await this.sink.emit(this.store.snapshot().jobs.find((item) => item.id === jobId)!, type, payload);
      } });
      if (controller.signal.aborted) return;
      await this.transition(jobId, "succeeded");
      await this.sink.emit(this.store.snapshot().jobs.find((item) => item.id === jobId)!, "job.completed", { output });
    } catch (error) {
      if (controller.signal.aborted) return;
      await this.transition(jobId, "failed", error instanceof Error ? error.message : "Host harness failed");
      await this.sink.emit(this.store.snapshot().jobs.find((item) => item.id === jobId)!, "job.failed", { error: error instanceof Error ? error.message : "Host harness failed" });
    } finally { this.controllers.delete(jobId); }
  }

  async cancel(jobId: string): Promise<void> {
    this.approvalResolvers.get(jobId)?.(false);
    this.controllers.get(jobId)?.abort();
    await this.transition(jobId, "canceled");
    const job = this.store.snapshot().jobs.find((item) => item.id === jobId);
    if (job) await this.sink.emit(job, "job.canceled", {});
  }

  async resume(jobId: string): Promise<void> {
    const job = this.store.snapshot().jobs.find((item) => item.id === jobId);
    if (!job || job.status !== "waiting-approval") throw new Error("Host job is not waiting for approval");
    const resolver = this.approvalResolvers.get(jobId);
    if (!resolver) throw new Error("Remote approval cannot resume after host restart without harness support");
    resolver(true);
  }

  shutdown(): void { for (const resolver of this.approvalResolvers.values()) resolver(false); this.approvalResolvers.clear(); for (const controller of this.controllers.values()) controller.abort(); this.controllers.clear(); }

  private async interrupt(jobId: string, error: string): Promise<void> { await this.transition(jobId, "interrupted", error); const job = this.store.snapshot().jobs.find((item) => item.id === jobId); if (job) await this.sink.emit(job, "job.failed", { error, interrupted: true }); }
  private async transition(jobId: string, status: RemoteJobRecord["status"], error?: string): Promise<void> {
    await this.store.mutate((state) => { const job = state.jobs.find((item) => item.id === jobId); if (!job) throw new Error("Host job was not found"); job.status = status; job.updatedAt = this.now(); if (error) job.error = error; });
  }
}
