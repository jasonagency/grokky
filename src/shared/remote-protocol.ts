import { createHmac, timingSafeEqual } from "node:crypto";

export const REMOTE_PROTOCOL = { major: 1, minor: 0 } as const;
export const MAX_REMOTE_FRAME_BYTES = 256 * 1024;

export interface RemoteHostCapabilities {
  protocol: { major: number; minor: number };
  hostId: string;
  harnesses: string[];
  controls: Array<"cancel" | "pause" | "resume" | "approve">;
  filesCompatibility: boolean;
  maxFrameBytes: number;
}

export interface RemoteJobRequest {
  id: string;
  idempotencyKey: string;
  taskId: string;
  attemptId: string;
  leaseEpoch: number;
  harnessId: string;
  payload: unknown;
  approvalPolicy: "ask" | "allow" | "deny";
  budgetUsd: number;
}

export type RemoteJobStatus = "queued" | "running" | "waiting-approval" | "succeeded" | "failed" | "canceled" | "interrupted";

export interface RemoteJobRecord extends RemoteJobRequest {
  status: RemoteJobStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface RemoteEventFrame {
  protocolMajor: number;
  cursor: number;
  jobId: string;
  leaseEpoch: number;
  type: "job.accepted" | "job.running" | "job.approval" | "job.output" | "job.completed" | "job.failed" | "job.canceled" | "diagnostic";
  payload: unknown;
  timestamp: number;
  signature: string;
}

export interface RemoteControlCommand {
  id: string;
  jobId: string;
  leaseEpoch: number;
  afterCursor: number;
  type: "cancel" | "pause" | "resume" | "approve";
  decision?: "allow" | "deny";
}

export interface RemoteHostState {
  protocolMajor: number;
  cursor: number;
  jobs: RemoteJobRecord[];
  events: RemoteEventFrame[];
  commandIds: string[];
}

export interface RemoteReconciliationState {
  revision: number;
  hostId?: string;
  acknowledgedCursor: number;
  events: RemoteEventFrame[];
  leaseEpochs: Record<string, number>;
  diagnostics: Array<{ cursor: number; jobId: string; detail: string }>;
}

export interface RemoteCompatibility {
  newJobsAllowed: boolean;
  exportAllowed: true;
  recoveryAllowed: true;
  reason: string;
}

export function assessRemoteCompatibility(remote: { major: number; minor: number }): RemoteCompatibility {
  if (remote.major !== REMOTE_PROTOCOL.major) {
    return {
      newJobsAllowed: false,
      exportAllowed: true,
      recoveryAllowed: true,
      reason: `Remote protocol ${remote.major}.${remote.minor} is incompatible with ${REMOTE_PROTOCOL.major}.${REMOTE_PROTOCOL.minor}; new jobs are blocked while export and recovery remain available.`,
    };
  }
  return {
    newJobsAllowed: true,
    exportAllowed: true,
    recoveryAllowed: true,
    reason: remote.minor === REMOTE_PROTOCOL.minor
      ? "Desktop and host protocols match."
      : `Compatible protocol skew (${REMOTE_PROTOCOL.major}.${REMOTE_PROTOCOL.minor} desktop, ${remote.major}.${remote.minor} host).`,
  };
}

export type ScreenKind = "browser" | "desktop";
export type ScreenController = "agent" | "operator" | "locked";
export interface ScreenLease {
  id: string;
  agentId: string;
  providerSessionId: string;
  kind: ScreenKind;
  epoch: number;
  controller: ScreenController;
  status: "active" | "paused" | "revoked" | "expired";
  delivery: "stream" | "snapshot";
  sharedTrustBoundary: true;
  acquiredAt: number;
  expiresAt: number;
}
export interface ScreenSnapshotFrame { leaseId: string; epoch: number; sequence: number; mediaType: "image/png" | "image/jpeg"; data: string; capturedAt: number }
export interface ScreenAuditEntry { id: string; leaseId: string; agentId: string; action: "lease" | "screenshot" | "agent-input" | "operator-takeover" | "operator-input" | "return-control" | "lock" | "revoke" | "failure"; status: "completed" | "failed"; detail: string; createdAt: number }
export interface AgentScreenSnapshot { leases: ScreenLease[]; audit: ScreenAuditEntry[]; history: Array<Omit<ScreenSnapshotFrame, "data">> }
export interface ScreenInput { type: "click" | "key" | "scroll"; x?: number; y?: number; key?: string; deltaY?: number; sensitivity?: "normal" | "password" | "passkey" | "two-factor" | "captcha" | "payment" }

function unsigned(frame: Omit<RemoteEventFrame, "signature">): string { return JSON.stringify(frame); }

export function signRemoteFrame(frame: Omit<RemoteEventFrame, "signature">, credential: string): RemoteEventFrame {
  if (Buffer.byteLength(unsigned(frame), "utf8") > MAX_REMOTE_FRAME_BYTES) throw new Error("Remote frame exceeds the size limit");
  return { ...frame, signature: createHmac("sha256", credential).update(unsigned(frame)).digest("base64url") };
}

export function verifyRemoteFrame(frame: RemoteEventFrame, credential: string): void {
  if (frame.protocolMajor !== REMOTE_PROTOCOL.major) throw new Error("Remote event protocol is incompatible");
  if (!Number.isSafeInteger(frame.cursor) || frame.cursor < 1 || !Number.isSafeInteger(frame.leaseEpoch) || frame.leaseEpoch < 1) throw new Error("Remote event cursor or lease epoch is invalid");
  if (Buffer.byteLength(JSON.stringify(frame), "utf8") > MAX_REMOTE_FRAME_BYTES) throw new Error("Remote frame exceeds the size limit");
  const expected = signRemoteFrame({ protocolMajor: frame.protocolMajor, cursor: frame.cursor, jobId: frame.jobId, leaseEpoch: frame.leaseEpoch, type: frame.type, payload: frame.payload, timestamp: frame.timestamp }, credential).signature;
  const left = Buffer.from(expected); const right = Buffer.from(frame.signature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("Remote event signature is invalid");
}

export function assertCompatibleProtocol(remote: { major: number; minor: number }): void {
  const compatibility = assessRemoteCompatibility(remote);
  if (!compatibility.newJobsAllowed) throw new Error(compatibility.reason);
}

export function assertSecureRemoteEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname);
  const privateOverlay = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\.)/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || privateOverlay))) throw new Error("Remote host requires HTTPS or authenticated private-overlay transport");
  if (url.username || url.password) throw new Error("Remote host URL must not contain credentials");
  return url.toString().replace(/\/$/, "");
}
