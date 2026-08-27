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

export type TaskGoalStatus = "active" | "paused" | "succeeded" | "failed" | "canceled";
export type TaskNodeStatus = "blocked" | "queued" | "leased" | "running" | "paused" | "succeeded" | "failed" | "canceled";
export type TaskAttemptStatus = "leased" | "running" | "succeeded" | "failed" | "interrupted" | "canceled";

export interface TaskAssignment {
  agentId?: string;
  harnessId?: string;
  model?: string;
  requiredCapabilities?: string[];
}

export interface TaskAttempt {
  id: string;
  taskId: string;
  number: number;
  status: TaskAttemptStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  recovery?: "expired-lease";
}

export interface TaskLease {
  id: string;
  taskId: string;
  attemptId: string;
  idempotencyKey: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

export interface TaskCheckpoint {
  id: string;
  taskId: string;
  attemptId: string;
  cursor: string;
  recoverable: boolean;
  createdAt: number;
}

export interface TaskOutcome {
  summary: string;
  completedAt: number;
  artifactIds?: string[];
}

export interface TaskMessage {
  id: string;
  text: string;
  createdAt: number;
  delivery: "queued";
}

export interface TaskGoal {
  id: string;
  title: string;
  objective: string;
  status: TaskGoalStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TaskNode {
  id: string;
  goalId: string;
  title: string;
  description: string;
  status: TaskNodeStatus;
  priority: number;
  dependsOn: string[];
  blockerChain: string[];
  assignment: TaskAssignment;
  maxAttempts: number;
  attempts: TaskAttempt[];
  lease?: TaskLease;
  checkpoints: TaskCheckpoint[];
  messages: TaskMessage[];
  outcome?: TaskOutcome;
  createdAt: number;
  updatedAt: number;
}

export interface TaskGraphSnapshot {
  revision: number;
  goals: TaskGoal[];
  tasks: TaskNode[];
}

export interface TaskNodeDraft {
  id: string;
  title: string;
  description?: string;
  priority?: number;
  dependsOn?: string[];
  assignment?: TaskAssignment;
  maxAttempts?: number;
}

export interface TaskGoalDraft {
  id: string;
  title: string;
  objective: string;
  nodes: TaskNodeDraft[];
}

export type TaskAction =
  | { type: "assign"; assignment: TaskAssignment }
  | { type: "message"; text: string }
  | { type: "reprioritize"; priority: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "cancel" }
  | { type: "retry" }
  | { type: "rewire"; dependsOn: string[] };

export interface TaskLeaseClaim {
  task: TaskNode;
  lease: TaskLease;
  checkpoint?: TaskCheckpoint;
}

export type WorkspaceLeaseKind = "git" | "directory";
export type WorkspaceLeaseMode = "read" | "write";
export type WorkspaceLeaseStatus = "active" | "completed" | "integrated" | "recovery";

export interface WorkspaceLease {
  id: string;
  taskId: string;
  repositoryId: string;
  kind: WorkspaceLeaseKind;
  mode: WorkspaceLeaseMode;
  writable: boolean;
  workspace: string;
  root: string;
  holderId: string;
  status: WorkspaceLeaseStatus;
  branch?: string;
  baseCommit?: string;
  recoveryReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceLeaseRequest {
  taskId: string;
  workspace: string;
  holderId: string;
  mode: WorkspaceLeaseMode;
}

export type IntegrationStatus = "queued" | "integrating" | "succeeded" | "conflict" | "failed";

export interface IntegrationVerification {
  command: string;
  ok: boolean;
  detail?: string;
}

export interface IntegrationRecord {
  id: string;
  taskId: string;
  leaseId?: string;
  repositoryId: string;
  taskBranch: string;
  targetRef: string;
  status: IntegrationStatus;
  resultCommit?: string;
  conflictFiles?: string[];
  error?: string;
  verification: IntegrationVerification[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceStateSnapshot {
  revision: number;
  leases: WorkspaceLease[];
  integrations: IntegrationRecord[];
}

export type ControlCommandType = "redirect" | "follow-up" | "pause" | "resume" | "stop" | "reprioritize" | "message";
export type ControlCommandStatus = "queued" | "delivered" | "acknowledged" | "rejected" | "expired" | "superseded";

export interface ControlCommandInput {
  taskId: string;
  attemptId?: string;
  harnessId: string;
  type: ControlCommandType;
  message?: string;
  priority?: number;
  idempotencyKey: string;
}

export type TaskControlRequest = Omit<ControlCommandInput, "taskId" | "harnessId">;

export interface ControlPolicyPatch {
  budgetPolicy?: BudgetPolicy;
  routingPolicy?: RoutingPolicy;
}

export interface ControlCommand extends ControlCommandInput {
  id: string;
  status: ControlCommandStatus;
  detail?: string;
  createdAt: number;
  updatedAt: number;
}

export type MeasurementQuality = "authoritative" | "estimated" | "delayed" | "unavailable";
export type BudgetMetric = "tokens" | "costUsd" | "elapsedMs" | "concurrency" | "retries" | "toolRisk";

export interface QualifiedMeasurement {
  value?: number;
  quality: MeasurementQuality;
}

export type BudgetMeasurements = Partial<Record<BudgetMetric, QualifiedMeasurement>>;

export interface BudgetThresholds {
  tokens?: number;
  costUsd?: number;
  elapsedMs?: number;
  concurrency?: number;
  retries?: number;
  toolRisk?: number;
}

export interface BudgetPolicy {
  hard: BudgetThresholds;
  soft: BudgetThresholds;
  reserveFraction: number;
}

export interface BudgetDecision {
  taskId?: string;
  status: "allowed" | "paused" | "blocked" | "advisory";
  metric?: BudgetMetric;
  measured?: number | null;
  threshold?: number;
  quality?: MeasurementQuality;
  enforceability: "hard" | "soft" | "advisory";
  reason: string;
}

export interface RoutingPolicy {
  requiredCapabilities: import("./harness-contracts").RequiredHarnessCapabilities;
  allowedHarnessIds?: string[];
  preferredModels: string[];
}

export interface RouteRejection { harnessId: string; reason: string }

export interface RouteDecision {
  taskId?: string;
  status: "selected" | "rejected";
  harnessId?: string;
  model?: string;
  reason: string;
  rejections: RouteRejection[];
}

export type NotificationType = "task-terminal" | "approval" | "budget-pause" | "routine-failed" | "integration-conflict" | "remote-disconnect" | "update-available";

export interface NotificationInput {
  type: NotificationType;
  title: string;
  body: string;
  taskId?: string;
}

export interface NotificationRecord extends NotificationInput {
  id: string;
  delivery: "os" | "in-app";
  deepLink?: string;
  createdAt: number;
}

export interface ControlRuntimeSnapshot {
  revision: number;
  commands: ControlCommand[];
  notifications: NotificationRecord[];
  budgetDecisions: BudgetDecision[];
  routeDecisions: RouteDecision[];
  budgetPolicy: BudgetPolicy;
  routingPolicy: RoutingPolicy;
}
