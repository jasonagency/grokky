import type { RemoteControlCommand, RemoteEventFrame, RemoteHostCapabilities, RemoteJobRecord, RemoteJobRequest, RemoteRoutineRecord, RemoteRoutineRegistration } from "../../shared/remote-protocol";
import { assertCompatibleProtocol, assertSecureRemoteEndpoint, verifyRemoteFrame } from "../../shared/remote-protocol";

export interface HostTransport {
  capabilities(): Promise<RemoteHostCapabilities>;
  submit(credential: string, request: RemoteJobRequest): Promise<RemoteJobRecord>;
  events(credential: string, afterCursor: number, limit?: number): Promise<RemoteEventFrame[]>;
  control(credential: string, command: RemoteControlCommand): Promise<{ accepted: boolean; duplicate?: boolean }>;
  routine?(credential: string, routine: RemoteRoutineRegistration): Promise<RemoteRoutineRecord>;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30_000);
  try { const response = await fetch(url, { ...init, signal: controller.signal }); const payload = await response.json() as { error?: string } & T; if (!response.ok) throw new Error(payload.error || `Remote host returned HTTP ${response.status}`); return payload; }
  finally { clearTimeout(timeout); }
}

export class FetchHostTransport implements HostTransport {
  private readonly endpoint: string;
  constructor(endpoint: string) { this.endpoint = assertSecureRemoteEndpoint(endpoint); }
  async capabilities(): Promise<RemoteHostCapabilities> {
    const payload = await json<{ hostCapabilities?: { agent?: RemoteHostCapabilities } }>(`${this.endpoint}/health`);
    if (!payload.hostCapabilities?.agent) throw new Error("Remote runner does not advertise agent-host jobs");
    return payload.hostCapabilities.agent;
  }
  async submit(credential: string, request: RemoteJobRequest): Promise<RemoteJobRecord> { return (await this.post<{ job: RemoteJobRecord }>(credential, "/host/jobs", { job: request })).job; }
  async events(credential: string, afterCursor: number, limit?: number): Promise<RemoteEventFrame[]> { return (await this.post<{ events: RemoteEventFrame[] }>(credential, "/host/events", { afterCursor, ...(limit ? { limit } : {}) })).events; }
  control(credential: string, command: RemoteControlCommand): Promise<{ accepted: boolean; duplicate?: boolean }> { return this.post(credential, "/host/control", { command }); }
  async routine(credential: string, routine: RemoteRoutineRegistration): Promise<RemoteRoutineRecord> { return (await this.post<{ routine: RemoteRoutineRecord }>(credential, "/host/routines", { routine })).routine; }
  private post<T>(credential: string, pathname: string, body: unknown): Promise<T> { return json(`${this.endpoint}${pathname}`, { method: "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
}

export class HostClient {
  private connected?: RemoteHostCapabilities;
  readonly endpoint: string;
  constructor(endpoint: string, private readonly credential: string, private readonly transport: HostTransport) { this.endpoint = assertSecureRemoteEndpoint(endpoint); }
  async connect(): Promise<RemoteHostCapabilities> { const capabilities = await this.transport.capabilities(); assertCompatibleProtocol(capabilities.protocol); this.connected = capabilities; return structuredClone(capabilities); }
  capabilities(): RemoteHostCapabilities { if (!this.connected) throw new Error("Remote host is not connected"); return structuredClone(this.connected); }
  async submit(request: RemoteJobRequest): Promise<RemoteJobRecord> { if (!this.connected) await this.connect(); return this.transport.submit(this.credential, request); }
  async events(afterCursor: number, limit = 200): Promise<RemoteEventFrame[]> {
    if (!this.connected) await this.connect();
    const frames = await this.transport.events(this.credential, afterCursor, limit);
    const unique = new Map<number, RemoteEventFrame>();
    for (const frame of frames) {
      verifyRemoteFrame(frame, this.credential);
      const existing = unique.get(frame.cursor);
      if (existing && JSON.stringify(existing) !== JSON.stringify(frame)) throw new Error(`Remote host returned conflicting event cursor ${frame.cursor}`);
      unique.set(frame.cursor, frame);
    }
    const ordered = [...unique.values()].filter((frame) => frame.cursor > afterCursor).sort((left, right) => left.cursor - right.cursor);
    for (let index = 0; index < ordered.length; index += 1) if (ordered[index]!.cursor !== afterCursor + index + 1) throw new Error(`Remote host event gap after cursor ${afterCursor + index}`);
    return ordered;
  }
  async control(command: RemoteControlCommand) { if (!this.connected) await this.connect(); return this.transport.control(this.credential, command); }
  async upsertRoutine(routine: RemoteRoutineRegistration): Promise<RemoteRoutineRecord> { if (!this.connected) await this.connect(); if (!this.transport.routine) throw new Error("Remote host does not support routine registration"); return this.transport.routine(this.credential, routine); }
}
