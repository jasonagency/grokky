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
  importLegacySnapshot(snapshot: string, source: string, importedAt: number): Promise<boolean>;
  inspect(): Promise<DatabaseInspection>;
  close(): Promise<void>;
}

export type DatabaseCommand =
  | { type: "initialize" }
  | { type: "read_snapshot" }
  | { type: "write_snapshot"; snapshot: string }
  | { type: "import_legacy_snapshot"; snapshot: string; source: string; importedAt: number }
  | { type: "inspect" }
  | { type: "close" };

export interface DatabaseRequest {
  id: number;
  command: DatabaseCommand;
}

export type DatabaseResponse =
  | { id: number; ok: true; value?: unknown }
  | { id: number; ok: false; error: string };
