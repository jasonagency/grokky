import type { EventAppendResult, EventDiagnostic, StoredEventAppend } from "../../shared/control-plane-contracts";

export interface DatabaseInspection {
  schemaVersion: number;
  appliedMigrations: number[];
  journalMode: string;
  tables: string[];
}

export interface ControlPlaneDatabase {
  initialize(): Promise<void>;
  readSnapshot(): Promise<string | null>;
  writeSnapshot(snapshot: string): Promise<void>;
  readTaskGraph(): Promise<string | null>;
  writeTaskGraph(snapshot: string): Promise<void>;
  importLegacySnapshot(snapshot: string, source: string, importedAt: number): Promise<boolean>;
  appendEvent(request: StoredEventAppend): Promise<EventAppendResult>;
  listEvents(): Promise<string[]>;
  listEventDiagnostics(): Promise<EventDiagnostic[]>;
  listConversationProjections(): Promise<Record<string, string>>;
  readEventArtifact(sha256: string): Promise<string | null>;
  inspect(): Promise<DatabaseInspection>;
  close(): Promise<void>;
}

export type DatabaseCommand =
  | { type: "initialize" }
  | { type: "read_snapshot" }
  | { type: "write_snapshot"; snapshot: string }
  | { type: "read_task_graph" }
  | { type: "write_task_graph"; snapshot: string }
  | { type: "import_legacy_snapshot"; snapshot: string; source: string; importedAt: number }
  | { type: "append_event"; request: StoredEventAppend }
  | { type: "list_events" }
  | { type: "list_event_diagnostics" }
  | { type: "list_conversation_projections" }
  | { type: "read_event_artifact"; sha256: string }
  | { type: "inspect" }
  | { type: "close" };

export interface DatabaseRequest {
  id: number;
  command: DatabaseCommand;
}

export type DatabaseResponse =
  | { id: number; ok: true; value?: unknown }
  | { id: number; ok: false; error: string };
