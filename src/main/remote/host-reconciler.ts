import type { RemoteEventFrame, RemoteReconciliationState } from "../../shared/remote-protocol";
import type { RemoteStateRepository } from "../storage/repositories/remote-state-repository";
import type { HostClient } from "./host-client";

export interface ReconcileResult { accepted: number; duplicates: number; stale: number; gapAfter?: number }

export class HostReconciler {
  constructor(private readonly repository: RemoteStateRepository, private readonly client: HostClient) {}
  initialize(): Promise<void> { return this.repository.initialize(); }

  async reconcile(): Promise<ReconcileResult> {
    const state = this.repository.snapshot();
    const frames = await this.client.events(state.acknowledgedCursor);
    return this.apply(frames);
  }

  async apply(input: RemoteEventFrame[]): Promise<ReconcileResult> {
    const state = this.repository.snapshot();
    const result: ReconcileResult = { accepted: 0, duplicates: 0, stale: 0 };
    const frames = [...input].sort((left, right) => left.cursor - right.cursor);
    for (const frame of frames) {
      if (frame.cursor <= state.acknowledgedCursor || state.events.some((event) => event.cursor === frame.cursor)) { result.duplicates += 1; continue; }
      if (frame.cursor !== state.acknowledgedCursor + 1) { result.gapAfter = state.acknowledgedCursor; break; }
      const currentEpoch = state.leaseEpochs[frame.jobId] ?? 0;
      if (frame.leaseEpoch < currentEpoch) {
        result.stale += 1;
        state.diagnostics.push({ cursor: frame.cursor, jobId: frame.jobId, detail: `Ignored stale lease epoch ${frame.leaseEpoch}; current epoch is ${currentEpoch}` });
      } else {
        state.leaseEpochs[frame.jobId] = frame.leaseEpoch;
        state.events.push(structuredClone(frame));
        result.accepted += 1;
      }
      state.acknowledgedCursor = frame.cursor;
    }
    state.hostId = this.client.capabilities().hostId;
    state.events = state.events.slice(-10_000); state.diagnostics = state.diagnostics.slice(-2_000);
    await this.repository.replace(state);
    return result;
  }

  snapshot(): RemoteReconciliationState { return this.repository.snapshot(); }
}
