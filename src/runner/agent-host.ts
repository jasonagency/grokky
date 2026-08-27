import { createHash, timingSafeEqual } from "node:crypto";
import type { RemoteControlCommand, RemoteEventFrame, RemoteHostCapabilities, RemoteJobRecord, RemoteJobRequest, RemoteRoutineRecord, RemoteRoutineRegistration } from "../shared/remote-protocol";
import { MAX_REMOTE_FRAME_BYTES, REMOTE_PROTOCOL, signRemoteFrame } from "../shared/remote-protocol";
import { HostHarnessRegistry } from "./host-harness-registry";
import { HostScheduler } from "./host-scheduler";
import type { HostStore } from "./host-store";
import type { ScreenSessionManager } from "./screen-session-manager";
import type { ScreenInput, ScreenKind } from "../shared/remote-protocol";
import { nextRoutineFire, validateRoutineSchedule } from "../shared/routine-schedule";

function digest(value: string): Buffer { return createHash("sha256").update(value).digest(); }
function validId(value: string): boolean { return /^[a-zA-Z0-9:_-]{1,180}$/.test(value); }
function stableId(prefix: string, value: string, length = 40): string { return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, length)}`; }
const approvalPolicies = new Set(["ask", "allow", "deny"]);

export class AgentHost {
  private credentialHash?: Buffer;
  private routineTimer?: ReturnType<typeof setInterval>;
  readonly scheduler: HostScheduler;
  constructor(readonly hostId: string, private readonly store: HostStore, readonly registry: HostHarnessRegistry, private readonly signingCredential: string, private readonly now = Date.now, readonly screens?: ScreenSessionManager) {
    this.credentialHash = digest(signingCredential);
    this.scheduler = new HostScheduler(store, registry, { emit: (job, type, payload) => this.append(job, type, payload, signingCredential) }, now);
  }

  async initialize(): Promise<void> { await this.store.initialize(); this.scheduler.recover(); await this.runDueRoutines().catch(() => undefined); this.routineTimer = setInterval(() => { void this.runDueRoutines().catch(() => undefined); }, 30_000); this.routineTimer.unref?.(); }
  capabilities(): RemoteHostCapabilities { return { protocol: REMOTE_PROTOCOL, hostId: this.hostId, harnesses: this.registry.ids(), harnessReadiness: this.registry.readiness(), controls: ["cancel", "resume", "approve"], filesCompatibility: true, ...(this.screens ? { screens: this.screens.kinds() } : {}), maxFrameBytes: MAX_REMOTE_FRAME_BYTES }; }

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
    if (command.type === "pause") return { accepted: false };
    await this.store.mutate((state) => { state.commandIds.push(command.id); state.commandIds = state.commandIds.slice(-2_000); });
    if (command.type === "cancel") await this.scheduler.cancel(job.id);
    else if (command.type === "approve") {
      if (command.decision === "deny") await this.scheduler.cancel(job.id); else await this.scheduler.resume(job.id);
    } else if (command.type === "resume") await this.scheduler.resume(job.id);
    return { accepted: true };
  }

  revoke(): void { this.credentialHash = undefined; }
  async shutdown(): Promise<void> { if (this.routineTimer) clearInterval(this.routineTimer); this.scheduler.shutdown(); await this.registry.cleanup(); }
  async upsertRoutine(credential: string, input: RemoteRoutineRegistration): Promise<RemoteRoutineRecord> {
    this.authorize(credential); this.validateRoutine(input); let record!: RemoteRoutineRecord;
    await this.store.mutate((state) => {
      const existing = state.routines.find((routine) => routine.id === input.id);
      if (existing && input.version < existing.version) throw new Error("Remote routine version cannot move backward");
      if (existing && input.version === existing.version) { const comparable = ({ lastOccurrenceKey: _last, updatedAt: _updated, nextFireAt: _next, ...value }: RemoteRoutineRecord) => value; const { nextFireAt: _inputNext, ...inputCore } = input; if (JSON.stringify(comparable(existing)) !== JSON.stringify(inputCore)) throw new Error("Remote routine version conflicts with its stored definition"); record = structuredClone(existing); return; }
      record = { ...structuredClone(input), updatedAt: this.now() };
      if (existing) state.routines[state.routines.indexOf(existing)] = record; else state.routines.push(record);
    });
    await this.runDueRoutines(); return structuredClone(record);
  }
  async runDueRoutines(): Promise<void> {
    for (const routine of this.store.snapshot().routines.filter((entry) => entry.enabled && entry.nextFireAt <= this.now())) {
      const occurrenceSource = `${routine.id}:${routine.nextFireAt}`;
      const occurrenceKey = stableId("routine-occurrence", occurrenceSource, 48);
      if (routine.lastOccurrenceKey === occurrenceKey) continue;
      const ids = new Map(routine.nodes.map((node) => [node.id, stableId("routine-job", `${occurrenceSource}:${node.id}`)]));
      for (const node of routine.nodes) await this.submit(this.signingCredential, { id: ids.get(node.id)!, idempotencyKey: stableId("routine-idempotency", `${occurrenceSource}:${routine.version}:${node.id}`, 48), taskId: ids.get(node.id)!.replace("routine-job:", "routine-task:"), attemptId: stableId("routine-attempt", `${occurrenceSource}:${node.id}`, 32), leaseEpoch: 1, harnessId: node.harnessId, payload: node.payload, approvalPolicy: node.approvalPolicy, budgetUsd: node.budgetUsd, dependsOn: node.dependsOn.map((id) => ids.get(id)!), routine: { routineId: routine.id, occurrenceKey, nodeId: node.id } });
      await this.store.mutate((state) => { const current = state.routines.find((entry) => entry.id === routine.id); if (!current || current.lastOccurrenceKey === occurrenceKey) return; current.lastOccurrenceKey = occurrenceKey; current.nextFireAt = nextRoutineFire(current.schedule, Math.max(this.now(), current.nextFireAt)); current.updatedAt = this.now(); });
      this.scheduler.wake();
    }
  }
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
    if (!approvalPolicies.has(request.approvalPolicy)) throw new Error("Remote job approval policy is invalid");
    if (!Number.isFinite(request.budgetUsd) || request.budgetUsd < 0) throw new Error("Remote job budget is invalid");
    if (request.dependsOn && (!Array.isArray(request.dependsOn) || request.dependsOn.length > 100 || request.dependsOn.some((id) => !validId(id)))) throw new Error("Remote job dependencies are invalid");
    if (request.routine && (![request.routine.routineId, request.routine.occurrenceKey, request.routine.nodeId].every(validId))) throw new Error("Remote routine job metadata is invalid");
    if (!this.registry.ids().includes(request.harnessId)) throw new Error("Remote job harness is unavailable");
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_REMOTE_FRAME_BYTES) throw new Error("Remote job exceeds the size limit");
  }
  private validateRoutine(input: RemoteRoutineRegistration): void {
    if (!validId(input.id) || !Number.isInteger(input.version) || input.version < 1 || typeof input.enabled !== "boolean" || !Number.isSafeInteger(input.nextFireAt) || input.nextFireAt < 0) throw new Error("Remote routine identity, version, or fire time is invalid");
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_REMOTE_FRAME_BYTES) throw new Error("Remote routine exceeds the size limit");
    if (!Array.isArray(input.nodes) || !input.nodes.length || input.nodes.length > 100) throw new Error("Remote routine requires between 1 and 100 nodes");
    validateRoutineSchedule(input.schedule, this.now()); const ids = new Set(input.nodes.map((node) => node.id));
    if (ids.size !== input.nodes.length || input.nodes.some((node) => !validId(node.id) || !validId(node.harnessId) || !this.registry.ids().includes(node.harnessId) || !Array.isArray(node.dependsOn) || node.dependsOn.length > 100 || node.dependsOn.some((id) => !ids.has(id)) || !approvalPolicies.has(node.approvalPolicy) || !Number.isFinite(node.budgetUsd) || node.budgetUsd < 0)) throw new Error("Remote routine nodes are invalid");
    const nodes = new Map(input.nodes.map((node) => [node.id, node])); const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (id: string) => { if (visited.has(id)) return; if (visiting.has(id)) throw new Error("Remote routine graph contains a cycle"); visiting.add(id); for (const dependency of nodes.get(id)!.dependsOn) visit(dependency); visiting.delete(id); visited.add(id); };
    for (const node of input.nodes) visit(node.id);
  }
  private async append(job: RemoteJobRecord, type: RemoteEventFrame["type"], payload: unknown, credential: string): Promise<void> {
    await this.store.mutate((state) => { const frame = signRemoteFrame({ protocolMajor: REMOTE_PROTOCOL.major, cursor: state.cursor + 1, jobId: job.id, leaseEpoch: job.leaseEpoch, type, payload: structuredClone(payload), timestamp: this.now() }, credential); state.cursor = frame.cursor; state.events.push(frame); });
  }
}
