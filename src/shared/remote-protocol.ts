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
  if (remote.major !== REMOTE_PROTOCOL.major) throw new Error(`Remote protocol ${remote.major}.${remote.minor} is incompatible with ${REMOTE_PROTOCOL.major}.${REMOTE_PROTOCOL.minor}`);
}

export function assertSecureRemoteEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname);
  const privateOverlay = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\.)/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || privateOverlay))) throw new Error("Remote host requires HTTPS or authenticated private-overlay transport");
  if (url.username || url.password) throw new Error("Remote host URL must not contain credentials");
  return url.toString().replace(/\/$/, "");
}
