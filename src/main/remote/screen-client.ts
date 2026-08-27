import type { AgentScreenSnapshot, ScreenInput, ScreenLease, ScreenSnapshotFrame } from "../../shared/remote-protocol";
import { assertSecureRemoteEndpoint } from "../../shared/remote-protocol";

export interface RemoteScreenTransport {
  snapshot(): Promise<AgentScreenSnapshot>;
  lease(agentId: string, kind: "browser" | "desktop"): Promise<ScreenLease>;
  capture(leaseId: string, epoch: number): Promise<ScreenSnapshotFrame>;
  agentInput(leaseId: string, epoch: number, agentId: string, input: ScreenInput): Promise<void>;
  takeover(leaseId: string, epoch: number): Promise<ScreenLease>;
  operatorInput(leaseId: string, epoch: number, input: ScreenInput): Promise<void>;
  returnControl(leaseId: string, epoch: number): Promise<ScreenLease>;
  lock(leaseId: string, epoch: number): Promise<ScreenLease>;
  revoke(leaseId: string, epoch: number): Promise<void>;
}
export class ScreenClient {
  constructor(private readonly transport: RemoteScreenTransport) {}
  snapshot() { return this.transport.snapshot(); }
  lease(agentId: string, kind: "browser" | "desktop") { return this.transport.lease(agentId, kind); }
  capture(leaseId: string, epoch: number) { return this.transport.capture(leaseId, epoch); }
  input(leaseId: string, epoch: number, agentId: string, input: ScreenInput) { return this.transport.agentInput(leaseId, epoch, agentId, input); }
  takeover(leaseId: string, epoch: number) { return this.transport.takeover(leaseId, epoch); }
  operatorInput(leaseId: string, epoch: number, input: ScreenInput) { return this.transport.operatorInput(leaseId, epoch, input); }
  returnControl(leaseId: string, epoch: number) { return this.transport.returnControl(leaseId, epoch); }
  lock(leaseId: string, epoch: number) { return this.transport.lock(leaseId, epoch); }
  revoke(leaseId: string, epoch: number) { return this.transport.revoke(leaseId, epoch); }
}

export class FetchRemoteScreenTransport implements RemoteScreenTransport {
  private readonly endpoint: string;
  constructor(endpoint: string, private readonly credential: string) { this.endpoint = assertSecureRemoteEndpoint(endpoint); }
  async snapshot() { return (await this.post<{ screens: AgentScreenSnapshot }>("/host/screens", {})).screens; }
  async lease(agentId: string, kind: "browser" | "desktop") { return (await this.post<{ lease: ScreenLease }>("/host/screens/lease", { agentId, kind })).lease; }
  async capture(leaseId: string, epoch: number) { return (await this.post<{ frame: ScreenSnapshotFrame }>("/host/screens/capture", { leaseId, epoch })).frame; }
  async agentInput(leaseId: string, epoch: number, agentId: string, input: ScreenInput) { await this.post("/host/screens/input", { leaseId, epoch, agentId, input }); }
  async takeover(leaseId: string, epoch: number) { return (await this.post<{ lease: ScreenLease }>("/host/screens/control", { leaseId, epoch, action: "takeover" })).lease; }
  async operatorInput(leaseId: string, epoch: number, input: ScreenInput) { await this.post("/host/screens/operator-input", { leaseId, epoch, input }); }
  async returnControl(leaseId: string, epoch: number) { return (await this.post<{ lease: ScreenLease }>("/host/screens/control", { leaseId, epoch, action: "return" })).lease; }
  async lock(leaseId: string, epoch: number) { return (await this.post<{ lease: ScreenLease }>("/host/screens/control", { leaseId, epoch, action: "lock" })).lease; }
  async revoke(leaseId: string, epoch: number) { await this.post("/host/screens/revoke", { leaseId, epoch }); }
  private async post<T = unknown>(pathname: string, body: unknown): Promise<T> { const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30_000); try { const response = await fetch(`${this.endpoint}${pathname}`, { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${this.credential}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }); const payload = await response.json() as { error?: string } & T; if (!response.ok) throw new Error(payload.error || `Remote screen host returned HTTP ${response.status}`); return payload; } finally { clearTimeout(timeout); } }
}
