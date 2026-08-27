import { randomUUID } from "node:crypto";
import type { AgentScreenSnapshot, ScreenAuditEntry, ScreenInput, ScreenKind, ScreenLease, ScreenSnapshotFrame } from "../shared/remote-protocol";

export interface ScreenProvider {
  kind: ScreenKind;
  create(agentId: string): Promise<{ sessionId: string; delivery: "stream" | "snapshot" }>;
  capture(sessionId: string): Promise<Omit<ScreenSnapshotFrame, "leaseId" | "epoch" | "sequence" | "capturedAt">>;
  input(sessionId: string, input: ScreenInput): Promise<void>;
  close(sessionId: string): Promise<void>;
}

export class ScreenSessionManager {
  private leases: ScreenLease[] = [];
  private audit: ScreenAuditEntry[] = [];
  private sequences = new Map<string, number>();
  private history: AgentScreenSnapshot["history"] = [];
  private readonly providers = new Map<ScreenKind, ScreenProvider>();
  constructor(providers: ScreenProvider[] = [], private readonly now = Date.now, private readonly leaseMs = 5 * 60_000, private readonly onAudit?: (entry: ScreenAuditEntry) => void) { for (const provider of providers) this.providers.set(provider.kind, provider); }
  kinds(): ScreenKind[] { return [...this.providers.keys()].sort(); }
  snapshot(): AgentScreenSnapshot { this.expire(); return structuredClone({ leases: this.leases, audit: this.audit.slice(-500), history: this.history.slice(-100) }); }

  async lease(agentId: string, kind: ScreenKind): Promise<ScreenLease> {
    this.expire();
    if (this.leases.some((lease) => lease.agentId === agentId && (lease.status === "active" || lease.status === "paused"))) throw new Error("Agent already owns an active screen lease");
    const provider = this.providers.get(kind); if (!provider) throw new Error(`${kind} screen provider is unavailable`);
    const session = await provider.create(agentId); const now = this.now();
    const lease: ScreenLease = { id: `screen:${randomUUID()}`, agentId, providerSessionId: session.sessionId, kind, epoch: 1, controller: "agent", status: "active", delivery: session.delivery, sharedTrustBoundary: true, acquiredAt: now, expiresAt: now + this.leaseMs };
    if (this.leases.some((item) => item.providerSessionId === lease.providerSessionId && item.status === "active")) { await provider.close(session.sessionId); throw new Error("Screen provider session is already leased"); }
    this.leases.push(lease); this.record(lease, "lease", "completed", `${kind} session leased with ${session.delivery} delivery`); return structuredClone(lease);
  }

  async capture(leaseId: string, epoch: number): Promise<ScreenSnapshotFrame> {
    const lease = this.requireLease(leaseId, epoch); const provider = this.providers.get(lease.kind)!;
    try { const value = await provider.capture(lease.providerSessionId); const sequence = (this.sequences.get(lease.id) ?? 0) + 1; this.sequences.set(lease.id, sequence); const frame = { ...value, leaseId, epoch, sequence, capturedAt: this.now() }; const { data: _data, ...metadata } = frame; this.history.push(metadata); this.history = this.history.slice(-100); this.record(lease, "screenshot", "completed", `Captured frame ${sequence}`); return frame; }
    catch (error) { lease.delivery = "snapshot"; this.record(lease, "failure", "failed", "Screen stream failed; snapshot fallback is active"); throw error; }
  }

  async agentInput(leaseId: string, epoch: number, agentId: string, input: ScreenInput): Promise<void> {
    const lease = this.requireLease(leaseId, epoch);
    if (lease.agentId !== agentId) return this.fail(lease, "Input agent does not own this screen lease");
    if (lease.controller !== "agent") return this.fail(lease, `Agent input is blocked while controller is ${lease.controller}`);
    if (input.sensitivity && input.sensitivity !== "normal") return this.fail(lease, `${input.sensitivity} input is human-only`);
    await this.providers.get(lease.kind)!.input(lease.providerSessionId, this.boundInput(input));
    this.record(lease, "agent-input", "completed", input.type);
  }

  takeover(leaseId: string, epoch: number): ScreenLease { const lease = this.requireLease(leaseId, epoch); lease.controller = "operator"; this.record(lease, "operator-takeover", "completed", "Agent input paused"); return structuredClone(lease); }
  async operatorInput(leaseId: string, epoch: number, input: ScreenInput): Promise<void> { const lease = this.requireLease(leaseId, epoch); if (lease.controller !== "operator") return this.fail(lease, "Operator must take control before input"); await this.providers.get(lease.kind)!.input(lease.providerSessionId, this.boundInput(input)); this.record(lease, "operator-input", "completed", `${input.type} input (content excluded)`); }
  returnControl(leaseId: string, epoch: number): ScreenLease { const lease = this.requireCurrentLease(leaseId, epoch); if (lease.controller !== "operator" && lease.controller !== "locked") throw new Error("Operator does not control this screen"); lease.controller = "agent"; lease.status = "active"; lease.expiresAt = this.now() + this.leaseMs; this.record(lease, "return-control", "completed", "Agent input resumed"); return structuredClone(lease); }
  lock(leaseId: string, epoch: number): ScreenLease { const lease = this.requireLease(leaseId, epoch); lease.controller = "locked"; lease.status = "paused"; this.record(lease, "lock", "completed", "All input stopped"); return structuredClone(lease); }
  async revoke(leaseId: string, epoch: number): Promise<void> { const lease = this.requireCurrentLease(leaseId, epoch); lease.status = "revoked"; lease.controller = "locked"; lease.epoch += 1; await this.providers.get(lease.kind)!.close(lease.providerSessionId); this.record(lease, "revoke", "completed", "Screen lease revoked"); }

  private requireLease(id: string, epoch: number): ScreenLease { this.expire(); const lease = this.leases.find((item) => item.id === id); if (!lease || lease.status !== "active" || lease.epoch !== epoch) throw new Error("Screen lease is expired, revoked, reassigned, or stale"); return lease; }
  private requireCurrentLease(id: string, epoch: number): ScreenLease { this.expire(); const lease = this.leases.find((item) => item.id === id); if (!lease || (lease.status !== "active" && lease.status !== "paused") || lease.epoch !== epoch) throw new Error("Screen lease is expired, revoked, reassigned, or stale"); return lease; }
  private expire(): void { const now = this.now(); for (const lease of this.leases) if ((lease.status === "active" || lease.status === "paused") && lease.expiresAt <= now) { lease.status = "expired"; lease.controller = "locked"; lease.epoch += 1; void this.providers.get(lease.kind)?.close(lease.providerSessionId).catch(() => undefined); this.record(lease, "failure", "failed", "Screen lease expired"); } }
  private boundInput(input: ScreenInput): ScreenInput { const value = structuredClone(input); if (value.type === "click" && (!Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x! < 0 || value.y! < 0 || value.x! > 20_000 || value.y! > 20_000)) throw new Error("Screen click coordinates are invalid"); if (value.type === "key" && (!value.key || value.key.length > 80)) throw new Error("Screen key input is invalid"); return value; }
  private fail(lease: ScreenLease, detail: string): never { this.record(lease, "failure", "failed", detail); throw new Error(detail); }
  private record(lease: ScreenLease, action: ScreenAuditEntry["action"], status: ScreenAuditEntry["status"], detail: string): void { const entry = { id: `screen-audit:${randomUUID()}`, leaseId: lease.id, agentId: lease.agentId, action, status, detail, createdAt: this.now() } satisfies ScreenAuditEntry; this.audit.push(entry); this.onAudit?.(structuredClone(entry)); }
}
