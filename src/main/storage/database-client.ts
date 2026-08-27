import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { applyMigrations } from "./migrations";
import type {
  ControlPlaneDatabase,
  DatabaseCommand,
  DatabaseInspection,
  DatabaseRequest,
  DatabaseResponse,
} from "./database-types";

const MINIMUM_NODE = [22, 13] as const;

export function assertSqliteRuntime(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map((value) => Number.parseInt(value, 10));
  if (major < MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor < MINIMUM_NODE[1])) {
    throw new Error(`Grokky requires Node.js 22.13 or newer for the built-in SQLite store; found ${version}.`);
  }
}

async function prepareDatabasePath(pathname: string): Promise<void> {
  await mkdir(dirname(pathname), { recursive: true });
  const handle = await open(pathname, "a", 0o600);
  await handle.close();
  await chmod(pathname, 0o600);
}

export class StorageDatabase {
  private readonly database: DatabaseSync;
  private readonly appliedMigrations: number[];

  constructor(pathname: string) {
    assertSqliteRuntime();
    this.database = new DatabaseSync(pathname, { timeout: 5_000 });
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.appliedMigrations = applyMigrations(this.database);
  }

  readSnapshot(): string | null {
    const row = this.database.prepare("SELECT payload FROM snapshots WHERE id = 1").get() as { payload?: unknown } | undefined;
    return typeof row?.payload === "string" ? row.payload : null;
  }

  writeSnapshot(snapshot: string): void {
    this.transaction(() => this.writeSnapshotRow(snapshot));
  }

  importLegacySnapshot(snapshot: string, source: string, importedAt: number): boolean {
    return this.transaction(() => {
      const marker = this.database.prepare("SELECT value FROM metadata WHERE key = ?").get("legacy_import_v2");
      if (marker) return false;
      this.writeSnapshotRow(snapshot);
      this.database.prepare(`
        INSERT INTO metadata(key, value, updated_at) VALUES (?, ?, ?)
      `).run("legacy_import_v2", JSON.stringify({ source, importedAt }), importedAt);
      return true;
    });
  }

  inspect(): DatabaseInspection {
    const tables = this.database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => String((row as { name: string }).name));
    const journal = this.database.prepare("PRAGMA journal_mode").get() as Record<string, unknown> | undefined;
    const journalMode = String(journal ? Object.values(journal)[0] : "unknown").toLowerCase();
    return {
      schemaVersion: this.appliedMigrations.at(-1) ?? 0,
      appliedMigrations: [...this.appliedMigrations],
      journalMode,
      tables,
    };
  }

  close(): void {
    this.database.close();
  }

  private writeSnapshotRow(snapshot: string): void {
    JSON.parse(snapshot);
    this.database.prepare(`
      INSERT INTO snapshots(id, payload, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(snapshot, Date.now());
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

export class DirectDatabaseClient implements ControlPlaneDatabase {
  private database?: StorageDatabase;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly pathname: string) {}

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      if (this.database) return;
      await prepareDatabasePath(this.pathname);
      this.database = new StorageDatabase(this.pathname);
    });
  }

  readSnapshot(): Promise<string | null> {
    return this.enqueue(() => this.requireDatabase().readSnapshot());
  }

  writeSnapshot(snapshot: string): Promise<void> {
    return this.enqueue(() => this.requireDatabase().writeSnapshot(snapshot));
  }

  importLegacySnapshot(snapshot: string, source: string, importedAt: number): Promise<boolean> {
    return this.enqueue(() => this.requireDatabase().importLegacySnapshot(snapshot, source, importedAt));
  }

  inspect(): Promise<DatabaseInspection> {
    return this.enqueue(() => this.requireDatabase().inspect());
  }

  async close(): Promise<void> {
    await this.enqueue(() => {
      this.database?.close();
      this.database = undefined;
    });
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireDatabase(): StorageDatabase {
    if (!this.database) throw new Error("Control-plane database is not initialized");
    return this.database;
  }
}

export class WorkerDatabaseClient implements ControlPlaneDatabase {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private requestId = 0;
  private closed = false;

  constructor(pathname: string) {
    assertSqliteRuntime();
    this.worker = new Worker(new URL("../database-worker.js", import.meta.url), { workerData: { pathname } });
    this.worker.on("message", (response: DatabaseResponse) => this.onResponse(response));
    this.worker.on("error", (error) => this.failPending(error));
    this.worker.on("exit", (code) => {
      if (!this.closed && code !== 0) this.failPending(new Error(`Database worker exited with code ${code}`));
    });
  }

  initialize(): Promise<void> {
    return this.request({ type: "initialize" }).then(() => undefined);
  }

  readSnapshot(): Promise<string | null> {
    return this.request({ type: "read_snapshot" });
  }

  writeSnapshot(snapshot: string): Promise<void> {
    return this.request({ type: "write_snapshot", snapshot }).then(() => undefined);
  }

  importLegacySnapshot(snapshot: string, source: string, importedAt: number): Promise<boolean> {
    return this.request({ type: "import_legacy_snapshot", snapshot, source, importedAt });
  }

  inspect(): Promise<DatabaseInspection> {
    return this.request({ type: "inspect" });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.request({ type: "close" });
    this.closed = true;
    await this.worker.terminate();
  }

  private request<T>(command: DatabaseCommand): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Database worker is closed"));
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker.postMessage({ id, command } satisfies DatabaseRequest);
    });
  }

  private onResponse(response: DatabaseResponse): void {
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    if (response.ok) request.resolve(response.value);
    else request.reject(new Error(response.error));
  }

  private failPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

export async function prepareWorkerDatabase(pathname: string): Promise<StorageDatabase> {
  await prepareDatabasePath(pathname);
  return new StorageDatabase(pathname);
}
