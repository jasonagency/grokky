import type { ComputerApprovalRequest, ComputerAuditEntry, Conversation } from "./contracts";

export const CONTROL_PLANE_EVENT_SCHEMA_VERSION = 1 as const;
export const MAX_INLINE_EVENT_PAYLOAD_BYTES = 48 * 1024;
export const MAX_EVENT_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const MAX_PROJECTION_CHANGE_BYTES = 256 * 1024;

export type ControlPlaneEventType =
  | "conversation.snapshot"
  | "run.started"
  | "provider.thread"
  | "provider.activity"
  | "orchestration.updated"
  | "usage.updated"
  | "approval.requested"
  | "approval.resolved"
  | "audit.recorded"
  | "run.final"
  | "run.completed"
  | "run.failed"
  | "run.stopped"
  | "diagnostic.recorded";

export interface EventArtifactReference {
  sha256: string;
  byteSize: number;
  mediaType: "application/json";
  storagePath: string;
  retentionUntil: number;
}

export interface ArtifactEventPayload {
  artifact: EventArtifactReference;
  preview: string;
}

export interface ControlPlaneEvent {
  id: string;
  aggregateId: string;
  conversationId?: string;
  runId?: string;
  taskId?: string;
  attemptId?: string;
  sequence: number;
  timestamp: number;
  source: string;
  type: ControlPlaneEventType;
  schemaVersion: typeof CONTROL_PLANE_EVENT_SCHEMA_VERSION;
  payload: unknown;
}

export interface EventDiagnostic {
  id: string;
  eventId: string;
  aggregateId: string;
  code: "aggregate_sequence_gap" | "invalid_event" | "projection_failed";
  detail: string;
  expectedSequence?: number;
  actualSequence?: number;
  createdAt: number;
}

export type EventAppendResult =
  | { status: "appended"; sequence: number }
  | { status: "duplicate"; sequence: number }
  | { status: "rejected"; expectedSequence: number; actualSequence: number; diagnostic: EventDiagnostic };

export interface StoredEventArtifact {
  reference: EventArtifactReference;
  content: string;
}

export interface StoredEventAppend {
  event: string;
  projection?: string;
  artifact?: StoredEventArtifact;
}

export type ProjectionChange =
  | {
      eventId: string;
      aggregateId: string;
      sequence: number;
      kind: "conversation";
      conversation: Conversation;
    }
  | {
      eventId: string;
      aggregateId: string;
      sequence: number;
      kind: "approval";
      approval: ComputerApprovalRequest;
    }
  | {
      eventId: string;
      aggregateId: string;
      sequence: number;
      kind: "audit";
      audit: ComputerAuditEntry;
    }
  | {
      eventId: string;
      aggregateId: string;
      sequence: number;
      kind: "diagnostic";
      diagnostic: EventDiagnostic;
    }
  | {
      eventId: string;
      aggregateId: string;
      sequence: number;
      kind: "none";
    };

export type NewControlPlaneEvent = Omit<ControlPlaneEvent, "id" | "sequence" | "timestamp" | "schemaVersion"> & {
  id?: string;
  timestamp?: number;
};
