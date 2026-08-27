import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type {
  ControlPlaneEvent,
  EventAppendResult,
  EventDiagnostic,
  StoredEventAppend,
} from "../../shared/control-plane-contracts";
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

  readTaskGraph(): string | null {
    const row = this.database.prepare("SELECT payload FROM task_graph_state WHERE id = 1").get() as { payload?: unknown } | undefined;
    return typeof row?.payload === "string" ? row.payload : null;
  }

  writeTaskGraph(snapshot: string): void {
    const value = JSON.parse(snapshot) as import("../../shared/control-plane-contracts").TaskGraphSnapshot;
    if (!Number.isInteger(value.revision) || !Array.isArray(value.goals) || !Array.isArray(value.tasks)) throw new Error("Invalid task graph snapshot");
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO task_graph_state(id, revision, payload, updated_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, payload = excluded.payload, updated_at = excluded.updated_at
      `).run(value.revision, snapshot, Date.now());
      this.database.exec("DELETE FROM task_messages; DELETE FROM task_checkpoints; DELETE FROM task_leases; DELETE FROM task_attempts; DELETE FROM task_edges; DELETE FROM tasks; DELETE FROM task_goals;");
      const insertGoal = this.database.prepare("INSERT INTO task_goals(id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)");
      for (const goal of value.goals) insertGoal.run(goal.id, JSON.stringify(goal), goal.createdAt, goal.updatedAt);
      const insertTask = this.database.prepare("INSERT INTO tasks(id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)");
      for (const task of value.tasks) insertTask.run(task.id, JSON.stringify(task), task.createdAt, task.updatedAt);
      const insertEdge = this.database.prepare("INSERT INTO task_edges(task_id, depends_on_task_id) VALUES (?, ?)");
      const insertAttempt = this.database.prepare("INSERT INTO task_attempts(id, task_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
      const insertLease = this.database.prepare("INSERT INTO task_leases(task_id, lease_id, payload, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)");
      const insertCheckpoint = this.database.prepare("INSERT INTO task_checkpoints(id, task_id, payload, created_at) VALUES (?, ?, ?, ?)");
      const insertMessage = this.database.prepare("INSERT INTO task_messages(id, task_id, payload, created_at) VALUES (?, ?, ?, ?)");
      for (const task of value.tasks) {
        for (const dependency of task.dependsOn) insertEdge.run(task.id, dependency);
        for (const attempt of task.attempts) insertAttempt.run(attempt.id, task.id, JSON.stringify(attempt), attempt.startedAt, attempt.completedAt ?? attempt.startedAt);
        if (task.lease) insertLease.run(task.id, task.lease.id, JSON.stringify(task.lease), task.lease.expiresAt, task.lease.heartbeatAt);
        for (const checkpoint of task.checkpoints) insertCheckpoint.run(checkpoint.id, task.id, JSON.stringify(checkpoint), checkpoint.createdAt);
        for (const message of task.messages) insertMessage.run(message.id, task.id, JSON.stringify(message), message.createdAt);
      }
    });
  }

  readWorkspaceState(): string | null {
    const row = this.database.prepare("SELECT payload FROM workspace_state WHERE id = 1").get() as { payload?: unknown } | undefined;
    return typeof row?.payload === "string" ? row.payload : null;
  }

  writeWorkspaceState(snapshot: string): void {
    const value = JSON.parse(snapshot) as import("../../shared/control-plane-contracts").WorkspaceStateSnapshot;
    if (!Number.isInteger(value.revision) || !Array.isArray(value.leases) || !Array.isArray(value.integrations)) throw new Error("Invalid workspace state snapshot");
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO workspace_state(id, revision, payload, updated_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, payload = excluded.payload, updated_at = excluded.updated_at
      `).run(value.revision, snapshot, Date.now());
      this.database.exec("DELETE FROM workspace_leases; DELETE FROM integration_queue;");
      const insertLease = this.database.prepare("INSERT INTO workspace_leases(id, task_id, repository_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const lease of value.leases) insertLease.run(lease.id, lease.taskId, lease.repositoryId, lease.status, JSON.stringify(lease), lease.createdAt, lease.updatedAt);
      const insertIntegration = this.database.prepare("INSERT INTO integration_queue(id, task_id, repository_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const integration of value.integrations) insertIntegration.run(integration.id, integration.taskId, integration.repositoryId, integration.status, JSON.stringify(integration), integration.createdAt, integration.updatedAt);
    });
  }

  readControlRuntime(): string | null {
    const row = this.database.prepare("SELECT payload FROM control_runtime_state WHERE id = 1").get() as { payload?: unknown } | undefined;
    return typeof row?.payload === "string" ? row.payload : null;
  }

  writeControlRuntime(snapshot: string): void {
    const value = JSON.parse(snapshot) as import("../../shared/control-plane-contracts").ControlRuntimeSnapshot;
    if (!Number.isInteger(value.revision) || !Array.isArray(value.commands) || !Array.isArray(value.notifications)) throw new Error("Invalid control runtime snapshot");
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO control_runtime_state(id, revision, payload, updated_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, payload = excluded.payload, updated_at = excluded.updated_at
      `).run(value.revision, snapshot, Date.now());
      this.database.exec("DELETE FROM control_commands; DELETE FROM notification_outbox;");
      const insertCommand = this.database.prepare("INSERT INTO control_commands(id, task_id, idempotency_key, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const command of value.commands) insertCommand.run(command.id, command.taskId, command.idempotencyKey, command.status, JSON.stringify(command), command.createdAt, command.updatedAt);
      const insertNotification = this.database.prepare("INSERT INTO notification_outbox(id, task_id, delivery, payload, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const notification of value.notifications) insertNotification.run(notification.id, notification.taskId ?? null, notification.delivery, JSON.stringify(notification), notification.createdAt);
    });
  }

  readQualityState(): string | null {
    const row = this.database.prepare("SELECT payload FROM quality_state WHERE id = 1").get() as { payload?: unknown } | undefined;
    return typeof row?.payload === "string" ? row.payload : null;
  }

  writeQualityState(snapshot: string): void {
    const value = JSON.parse(snapshot) as import("../../shared/control-plane-contracts").EvalStateSnapshot;
    if (!Number.isInteger(value.revision) || !Array.isArray(value.cases) || !Array.isArray(value.runs)) throw new Error("Invalid quality state snapshot");
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO quality_state(id, revision, payload, updated_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, payload = excluded.payload, updated_at = excluded.updated_at
      `).run(value.revision, snapshot, Date.now());
      this.database.exec("DELETE FROM eval_runs; DELETE FROM eval_cases;");
      const insertCase = this.database.prepare("INSERT INTO eval_cases(id, version, payload, created_at) VALUES (?, ?, ?, ?)");
      for (const entry of value.cases) insertCase.run(entry.id, entry.version, JSON.stringify(entry), entry.createdAt);
      const insertRun = this.database.prepare("INSERT INTO eval_runs(id, case_id, case_version, payload, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const run of value.runs) insertRun.run(run.id, run.caseId, run.caseVersion, JSON.stringify(run), run.createdAt);
    });
  }

  readTeamState(): string | null {
    const row = this.database.prepare("SELECT payload FROM team_state WHERE id = 1").get() as { payload?: unknown } | undefined;
    return typeof row?.payload === "string" ? row.payload : null;
  }

  writeTeamState(snapshot: string): void {
    const value = JSON.parse(snapshot) as import("../../shared/contracts").TeamStateSnapshot;
    if (!Number.isInteger(value.revision) || !Array.isArray(value.agents) || !Array.isArray(value.messages) || !Array.isArray(value.memories) || !Array.isArray(value.routines)) throw new Error("Invalid team state snapshot");
    this.transaction(() => {
      this.database.prepare(`INSERT INTO team_state(id, revision, payload, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, payload = excluded.payload, updated_at = excluded.updated_at`).run(value.revision, snapshot, Date.now());
      this.database.exec("DELETE FROM agent_mailbox; DELETE FROM agent_memories; DELETE FROM agent_routines; DELETE FROM agent_runtimes;");
      const agent = this.database.prepare("INSERT INTO agent_runtimes(id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
      for (const item of value.agents) agent.run(item.id, item.status, JSON.stringify(item), item.createdAt, item.updatedAt);
      const message = this.database.prepare("INSERT INTO agent_mailbox(id, thread_id, task_id, payload, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const item of value.messages) message.run(item.id, item.threadId, item.taskId ?? null, JSON.stringify(item), item.createdAt);
      const memory = this.database.prepare("INSERT INTO agent_memories(id, agent_id, review_status, payload, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const item of value.memories) memory.run(item.id, item.agentId, item.reviewStatus, JSON.stringify(item), item.createdAt);
      const routine = this.database.prepare("INSERT INTO agent_routines(id, owner_agent_id, active, next_fire_at, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const item of value.routines) routine.run(item.id, item.ownerAgentId, item.active ? 1 : 0, item.nextFireAt, JSON.stringify(item), item.createdAt, item.updatedAt);
    });
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

  appendEvent(request: StoredEventAppend): EventAppendResult {
    const event = JSON.parse(request.event) as ControlPlaneEvent;
    return this.transaction(() => {
      const duplicate = this.database.prepare("SELECT aggregate_sequence FROM events WHERE id = ?").get(event.id) as { aggregate_sequence: number } | undefined;
      if (duplicate) return { status: "duplicate", sequence: duplicate.aggregate_sequence };

      const latest = this.database.prepare("SELECT MAX(aggregate_sequence) AS sequence FROM events WHERE aggregate_id = ?").get(event.aggregateId) as { sequence: number | null };
      const expectedSequence = (latest.sequence ?? 0) + 1;
      if (event.sequence !== expectedSequence) {
        const diagnostic: EventDiagnostic = {
          id: `diagnostic:${event.id}`,
          eventId: event.id,
          aggregateId: event.aggregateId,
          code: "aggregate_sequence_gap",
          detail: `Rejected aggregate sequence ${event.sequence}; expected ${expectedSequence}.`,
          expectedSequence,
          actualSequence: event.sequence,
          createdAt: Date.now(),
        };
        this.database.prepare(`
          INSERT OR IGNORE INTO event_diagnostics(
            id, event_id, aggregate_id, code, detail, expected_sequence, actual_sequence, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          diagnostic.id,
          diagnostic.eventId,
          diagnostic.aggregateId,
          diagnostic.code,
          diagnostic.detail,
          diagnostic.expectedSequence ?? null,
          diagnostic.actualSequence ?? null,
          diagnostic.createdAt,
        );
        const stored = this.database.prepare("SELECT * FROM event_diagnostics WHERE event_id = ?").get(event.id) as Record<string, unknown>;
        return {
          status: "rejected",
          expectedSequence,
          actualSequence: event.sequence,
          diagnostic: this.diagnosticFromRow(stored),
        };
      }

      if (request.artifact) {
        const { reference, content } = request.artifact;
        this.database.prepare(`
          INSERT OR IGNORE INTO event_artifacts(sha256, content, byte_size, media_type, retention_until, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(reference.sha256, Buffer.from(content, "utf8"), reference.byteSize, reference.mediaType, reference.retentionUntil, event.timestamp);
        this.database.prepare(`
          INSERT OR IGNORE INTO artifacts(id, sha256, byte_size, media_type, storage_path, retention_until, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(reference.sha256, reference.sha256, reference.byteSize, reference.mediaType, reference.storagePath, reference.retentionUntil, event.timestamp);
      }
      this.database.prepare(`
        INSERT INTO events(id, aggregate_id, aggregate_sequence, event_type, schema_version, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(event.id, event.aggregateId, event.sequence, event.type, event.schemaVersion, request.event, event.timestamp);
      if (request.projection) {
        JSON.parse(request.projection);
        this.database.prepare(`
          INSERT INTO conversation_projections(aggregate_id, aggregate_sequence, payload, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(aggregate_id) DO UPDATE SET
            aggregate_sequence = excluded.aggregate_sequence,
            payload = excluded.payload,
            updated_at = excluded.updated_at
        `).run(event.aggregateId, event.sequence, request.projection, event.timestamp);
      }
      return { status: "appended", sequence: event.sequence };
    });
  }

  listEvents(): string[] {
    return this.database.prepare("SELECT payload FROM events ORDER BY created_at, aggregate_id, aggregate_sequence").all()
      .map((row) => String((row as { payload: string }).payload));
  }

  listEventDiagnostics(): EventDiagnostic[] {
    return this.database.prepare("SELECT * FROM event_diagnostics ORDER BY created_at, id").all()
      .map((row) => this.diagnosticFromRow(row as Record<string, unknown>));
  }

  listConversationProjections(): Record<string, string> {
    return Object.fromEntries(this.database.prepare("SELECT aggregate_id, payload FROM conversation_projections ORDER BY aggregate_id").all()
      .map((row) => {
        const projection = row as { aggregate_id: string; payload: string };
        return [projection.aggregate_id, projection.payload];
      }));
  }

  readEventArtifact(sha256: string): string | null {
    const row = this.database.prepare("SELECT content FROM event_artifacts WHERE sha256 = ?").get(sha256) as { content?: unknown } | undefined;
    if (!row?.content) return null;
    return Buffer.from(row.content as Uint8Array).toString("utf8");
  }

  deleteExpiredEventArtifacts(now: number): number {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid artifact retention time");
    return this.transaction(() => {
      const expired = this.database.prepare("SELECT sha256 FROM event_artifacts WHERE retention_until <= ?").all(now) as Array<{ sha256: string }>;
      const removeContent = this.database.prepare("DELETE FROM event_artifacts WHERE sha256 = ?");
      const removeCatalog = this.database.prepare("DELETE FROM artifacts WHERE sha256 = ? AND retention_until <= ?");
      for (const { sha256 } of expired) {
        removeContent.run(sha256);
        removeCatalog.run(sha256, now);
      }
      return expired.length;
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

  private diagnosticFromRow(row: Record<string, unknown>): EventDiagnostic {
    return {
      id: String(row.id),
      eventId: String(row.event_id),
      aggregateId: String(row.aggregate_id),
      code: String(row.code) as EventDiagnostic["code"],
      detail: String(row.detail),
      ...(typeof row.expected_sequence === "number" ? { expectedSequence: row.expected_sequence } : {}),
      ...(typeof row.actual_sequence === "number" ? { actualSequence: row.actual_sequence } : {}),
      createdAt: Number(row.created_at),
    };
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

  readTaskGraph(): Promise<string | null> {
    return this.enqueue(() => this.requireDatabase().readTaskGraph());
  }

  writeTaskGraph(snapshot: string): Promise<void> {
    return this.enqueue(() => this.requireDatabase().writeTaskGraph(snapshot));
  }

  readWorkspaceState(): Promise<string | null> {
    return this.enqueue(() => this.requireDatabase().readWorkspaceState());
  }

  writeWorkspaceState(snapshot: string): Promise<void> {
    return this.enqueue(() => this.requireDatabase().writeWorkspaceState(snapshot));
  }

  readControlRuntime(): Promise<string | null> {
    return this.enqueue(() => this.requireDatabase().readControlRuntime());
  }

  writeControlRuntime(snapshot: string): Promise<void> {
    return this.enqueue(() => this.requireDatabase().writeControlRuntime(snapshot));
  }

  readQualityState(): Promise<string | null> {
    return this.enqueue(() => this.requireDatabase().readQualityState());
  }

  writeQualityState(snapshot: string): Promise<void> {
    return this.enqueue(() => this.requireDatabase().writeQualityState(snapshot));
  }

  readTeamState(): Promise<string | null> {
    return this.enqueue(() => this.requireDatabase().readTeamState());
  }

  writeTeamState(snapshot: string): Promise<void> {
    return this.enqueue(() => this.requireDatabase().writeTeamState(snapshot));
  }

  importLegacySnapshot(snapshot: string, source: string, importedAt: number): Promise<boolean> {
    return this.enqueue(() => this.requireDatabase().importLegacySnapshot(snapshot, source, importedAt));
  }

  appendEvent(request: StoredEventAppend): Promise<EventAppendResult> {
    return this.enqueue(() => this.requireDatabase().appendEvent(request));
  }

  listEvents(): Promise<string[]> {
    return this.enqueue(() => this.requireDatabase().listEvents());
  }

  listEventDiagnostics(): Promise<EventDiagnostic[]> {
    return this.enqueue(() => this.requireDatabase().listEventDiagnostics());
  }

  listConversationProjections(): Promise<Record<string, string>> {
    return this.enqueue(() => this.requireDatabase().listConversationProjections());
  }

  readEventArtifact(sha256: string): Promise<string | null> {
    return this.enqueue(() => this.requireDatabase().readEventArtifact(sha256));
  }

  deleteExpiredEventArtifacts(now: number): Promise<number> {
    return this.enqueue(() => this.requireDatabase().deleteExpiredEventArtifacts(now));
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

  readTaskGraph(): Promise<string | null> {
    return this.request({ type: "read_task_graph" });
  }

  writeTaskGraph(snapshot: string): Promise<void> {
    return this.request({ type: "write_task_graph", snapshot }).then(() => undefined);
  }

  readWorkspaceState(): Promise<string | null> {
    return this.request({ type: "read_workspace_state" });
  }

  writeWorkspaceState(snapshot: string): Promise<void> {
    return this.request({ type: "write_workspace_state", snapshot }).then(() => undefined);
  }

  readControlRuntime(): Promise<string | null> {
    return this.request({ type: "read_control_runtime" });
  }

  writeControlRuntime(snapshot: string): Promise<void> {
    return this.request({ type: "write_control_runtime", snapshot }).then(() => undefined);
  }

  readQualityState(): Promise<string | null> {
    return this.request({ type: "read_quality_state" });
  }

  writeQualityState(snapshot: string): Promise<void> {
    return this.request({ type: "write_quality_state", snapshot }).then(() => undefined);
  }

  readTeamState(): Promise<string | null> {
    return this.request({ type: "read_team_state" });
  }

  writeTeamState(snapshot: string): Promise<void> {
    return this.request({ type: "write_team_state", snapshot }).then(() => undefined);
  }

  importLegacySnapshot(snapshot: string, source: string, importedAt: number): Promise<boolean> {
    return this.request({ type: "import_legacy_snapshot", snapshot, source, importedAt });
  }

  appendEvent(request: StoredEventAppend): Promise<EventAppendResult> {
    return this.request({ type: "append_event", request });
  }

  listEvents(): Promise<string[]> {
    return this.request({ type: "list_events" });
  }

  listEventDiagnostics(): Promise<EventDiagnostic[]> {
    return this.request({ type: "list_event_diagnostics" });
  }

  listConversationProjections(): Promise<Record<string, string>> {
    return this.request({ type: "list_conversation_projections" });
  }

  readEventArtifact(sha256: string): Promise<string | null> {
    return this.request({ type: "read_event_artifact", sha256 });
  }

  deleteExpiredEventArtifacts(now: number): Promise<number> {
    return this.request({ type: "delete_expired_event_artifacts", now });
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
