import { createHash, timingSafeEqual } from "node:crypto";
import type { RemoteControlCommand, RemoteEventFrame, RemoteHostCapabilities, RemoteJobRecord, RemoteJobRequest } from "../shared/remote-protocol";
import { MAX_REMOTE_FRAME_BYTES, REMOTE_PROTOCOL, signRemoteFrame } from "../shared/remote-protocol";
import { HostHarnessRegistry } from "./host-harness-registry";
import { HostScheduler } from "./host-scheduler";
import type { HostStore } from "./host-store";
import type { ScreenSessionManager } from "./screen-session-manager";
import type { ScreenInput, ScreenKind } from "../shared/remote-protocol";

function digest(value: string): Buffer { return createHash("sha256").update(value).digest(); }
function validId(value: string): boolean { return /^[a-zA-Z0-9:_-]{1,180}$/.test(value); }

export class AgentHost {
  private credentialHash?: Buffer;
  readonly scheduler: HostScheduler;
  constructor(readonly hostId: string, private readonly store: HostStore, readonly registry: HostHarnessRegistry, credential: string, private readonly now = Date.now, readonly screens?: ScreenSessionManager) {
    this.credentialHash = digest(credential);
    this.scheduler = new HostScheduler(store, registry, { emit: (job, type, payload) => this.append(job, type, payload, credential) }, now);
  }

  async initialize(): Promise<void> { await this.store.initialize(); this.scheduler.recover(); }
  capabilities(): RemoteHostCapabilities { return { protocol: REMOTE_PROTOCOL, hostId: this.hostId, harnesses: this.registry.ids(), controls: ["cancel", "pause", "resume", "approve"], filesCompatibility: true, maxFrameBytes: MAX_REMOTE_FRAME_BYTES }; }

  async submit(credential: string, request: RemoteJobRequest): Promise<RemoteJobRecord> {
    this.authorize(credential); this.validateRequest(request);
    let accepted!: RemoteJobRecord; let created = false;
    await this.store.mutate((state) => {
      const existing = state.jobs.find((job) => job.idempotencyKey === request.idempotencyKey || job.id === request.id);
      if (existing) { accepted = structuredClone(existing); return; }
      const taskJobs = state.jobs.filter((job) => job.taskId === request.taskId);
      const owned = taskJobs.find((job) => !new Set(["succeeded", "failed", "canceled", "interrupted"]).has(job.status));
      if (owned) throw new Error(`Remote task is owned by host job ${owned.id} at lease epoch ${owned.leaseEpoch}`);
      const latestEpoch = Math.max(0, ...taskJobs.map((job) => job.leaseEpoch));
      if (request.leaseEpoch <= latestEpoch) throw new Error(`Remote job lease epoch must advance beyond ${latestEpoch}`);
      created = true; const now = this.now(); accepted = { ...structuredClone(request), status: "queued", createdAt: now, updatedAt: now }; state.jobs.push(accepted);
    });
    if (created) { await this.append(accepted, "job.accepted", {}, credential); void this.scheduler.start(accepted.id); }
    return structuredClone(accepted);
  }

  events(credential: string, afterCursor: number, limit = 200): RemoteEventFrame[] {
    this.authorize(credential);
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Remote event cursor request is invalid");
    return this.store.snapshot().events.filter((event) => event.cursor > afterCursor).slice(0, limit);
  }

  async control(credential: string, command: RemoteControlCommand): Promise<{ accepted: boolean; duplicate?: boolean }> {
    this.authorize(credential);
    if (!validId(command.id) || !validId(command.jobId)) throw new Error("Remote control command is invalid");
    const snapshot = this.store.snapshot(); const job = snapshot.jobs.find((item) => item.id === command.jobId);
    if (!job) throw new Error("Remote host job was not found");
    if (command.leaseEpoch !== job.leaseEpoch) throw new Error("Remote control command has a stale lease epoch");
    if (command.afterCursor < snapshot.cursor - 10_000) throw new Error("Remote control command cursor is stale");
    if (snapshot.commandIds.includes(command.id)) return { accepted: true, duplicate: true };
    await this.store.mutate((state) => { state.commandIds.push(command.id); state.commandIds = state.commandIds.slice(-2_000); });
    if (command.type === "cancel") await this.scheduler.cancel(job.id);
    else if (command.type === "approve") {
      if (command.decision === "deny") await this.scheduler.cancel(job.id); else await this.scheduler.resume(job.id);
    } else if (command.type === "resume") await this.scheduler.resume(job.id);
    else await this.append(job, "diagnostic", { control: "pause", status: "accepted" }, credential);
    return { accepted: true };
  }

  revoke(): void { this.credentialHash = undefined; }
  snapshot() { return this.store.snapshot(); }
  screenSnapshot(credential: string) { this.authorize(credential); if (!this.screens) throw new Error("Remote screen sessions are unavailable"); return this.screens.snapshot(); }
  leaseScreen(credential: string, agentId: string, kind: ScreenKind) { this.authorize(credential); if (!this.screens) throw new Error("Remote screen sessions are unavailable"); return this.screens.lease(agentId, kind); }
  captureScreen(credential: string, leaseId: string, epoch: number) { this.authorize(credential); if (!this.screens) throw new Error("Remote screen sessions are unavailable"); return this.screens.capture(leaseId, epoch); }
  agentScreenInput(credential: string, leaseId: string, epoch: number, agentId: string, input: ScreenInput) { this.authorize(credential); if (!this.screens) throw new Error("Remote screen sessions are unavailable"); return this.screens.agentInput(leaseId, epoch, agentId, input); }
  takeoverScreen(credential: string, leaseId: string, epoch: number) { this.authorize(credential); if (!this.screens) throw new Error("Remote screen sessions are unavailable"); return this.screens.takeover(leaseId, epoch); }
  operatorScreenInput(credential: string, leaseId: string, epoch: number, input: ScreenInput) { this.authorize(credential); if (!this.screens) throw new Error("Remote screen sessions are unavailable"); return this.screens.operatorInput(leaseId, epoch, input); }
  returnScreen(credential: string, leaseId: string, epoch: number) { this.authorize(credential); if (!this.screens) throw new Error("Remote screen sessions are unavailable"); return this.screens.returnControl(leaseId, epoch); }
  lockScreen(credential: string, leaseId: string, epoch: number) { this.authorize(credential); if (!this.screens) throw new Error("Remote screen sessions are unavailable"); return this.screens.lock(leaseId, epoch); }
  revokeScreen(credential: string, leaseId: string, epoch: number) { this.authorize(credential); if (!this.screens) throw new Error("Remote screen sessions are unavailable"); return this.screens.revoke(leaseId, epoch); }

  private authorize(credential: string): void { const supplied = digest(credential); if (!this.credentialHash || this.credentialHash.length !== supplied.length || !timingSafeEqual(this.credentialHash, supplied)) throw new Error("Remote host authorization failed"); }
  private validateRequest(request: RemoteJobRequest): void {
    if (![request.id, request.idempotencyKey, request.taskId, request.attemptId, request.harnessId].every(validId)) throw new Error("Remote job identity is invalid");
    if (!Number.isSafeInteger(request.leaseEpoch) || request.leaseEpoch < 1) throw new Error("Remote job lease epoch is invalid");
    if (!Number.isFinite(request.budgetUsd) || request.budgetUsd < 0) throw new Error("Remote job budget is invalid");
    if (!this.registry.ids().includes(request.harnessId)) throw new Error("Remote job harness is unavailable");
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_REMOTE_FRAME_BYTES) throw new Error("Remote job exceeds the size limit");
  }
  private async append(job: RemoteJobRecord, type: RemoteEventFrame["type"], payload: unknown, credential: string): Promise<void> {
    await this.store.mutate((state) => { const frame = signRemoteFrame({ protocolMajor: REMOTE_PROTOCOL.major, cursor: state.cursor + 1, jobId: job.id, leaseEpoch: job.leaseEpoch, type, payload: structuredClone(payload), timestamp: this.now() }, credential); state.cursor = frame.cursor; state.events.push(frame); });
  }
}
