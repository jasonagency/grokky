import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  apply(database: DatabaseSync): void;
}

const migrations: Migration[] = [{
  version: 1,
  apply(database) {
    database.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE snapshots (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
      ) STRICT;

      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        aggregate_id TEXT NOT NULL,
        aggregate_sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (aggregate_id, aggregate_sequence)
      ) STRICT;

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE policies (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE secrets_metadata (
        id TEXT PRIMARY KEY,
        source_label TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        retention_until INTEGER,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX events_run_order ON events(aggregate_id, aggregate_sequence);
      CREATE INDEX messages_conversation_order ON messages(conversation_id, created_at);
      CREATE INDEX runs_conversation_order ON runs(conversation_id, created_at);
    `);
  },
}, {
  version: 2,
  apply(database) {
    database.exec(`
      CREATE TABLE conversation_projections (
        aggregate_id TEXT PRIMARY KEY,
        aggregate_sequence INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE event_diagnostics (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        aggregate_id TEXT NOT NULL,
        code TEXT NOT NULL,
        detail TEXT NOT NULL,
        expected_sequence INTEGER,
        actual_sequence INTEGER,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE event_artifacts (
        sha256 TEXT PRIMARY KEY,
        content BLOB NOT NULL,
        byte_size INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        retention_until INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX event_diagnostics_aggregate_order ON event_diagnostics(aggregate_id, created_at);
    `);
  },
}, {
  version: 3,
  apply(database) {
    database.exec(`
      CREATE TABLE task_graph_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE task_goals (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE task_edges (
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        PRIMARY KEY (task_id, depends_on_task_id),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE task_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE task_leases (
        task_id TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE task_checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE task_messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX task_attempts_task_order ON task_attempts(task_id, created_at);
      CREATE INDEX task_checkpoints_task_order ON task_checkpoints(task_id, created_at);
      CREATE INDEX task_messages_task_order ON task_messages(task_id, created_at);
      CREATE INDEX task_leases_expiry ON task_leases(expires_at);
    `);
  },
}, {
  version: 4,
  apply(database) {
    database.exec(`
      CREATE TABLE workspace_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE workspace_leases (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE integration_queue (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX workspace_leases_repository_status ON workspace_leases(repository_id, status);
      CREATE INDEX integration_queue_status_order ON integration_queue(status, created_at);
    `);
  },
}, {
  version: 5,
  apply(database) {
    database.exec(`
      CREATE TABLE control_runtime_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE control_commands (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE notification_outbox (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        delivery TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX control_commands_task_order ON control_commands(task_id, created_at);
      CREATE INDEX notification_outbox_task_order ON notification_outbox(task_id, created_at);
    `);
  },
}, {
  version: 6,
  apply(database) {
    database.exec(`
      CREATE TABLE quality_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE eval_cases (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (id, version)
      ) STRICT;

      CREATE TABLE eval_runs (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        case_version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (case_id, case_version) REFERENCES eval_cases(id, version) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX eval_runs_case_order ON eval_runs(case_id, case_version, created_at);
    `);
  },
}, {
  version: 7,
  apply(database) {
    database.exec(`
      CREATE TABLE team_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE agent_runtimes (id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE agent_mailbox (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, task_id TEXT, payload TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE agent_memories (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, review_status TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE agent_routines (id TEXT PRIMARY KEY, owner_agent_id TEXT NOT NULL, active INTEGER NOT NULL CHECK (active IN (0, 1)), next_fire_at INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE INDEX agent_mailbox_thread_order ON agent_mailbox(thread_id, created_at);
      CREATE INDEX agent_memories_agent_order ON agent_memories(agent_id, created_at);
      CREATE INDEX agent_routines_due ON agent_routines(active, next_fire_at);
    `);
  },
}, {
  version: 8,
  apply(database) {
    database.exec(`CREATE TABLE remote_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;`);
  },
}];

export function applyMigrations(database: DatabaseSync): number[] {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);
  const applied = new Set(
    database.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
      .map((row) => Number((row as { version: number }).version)),
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      migration.apply(database);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, Date.now());
      database.exec("COMMIT");
      applied.add(migration.version);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  return [...applied].sort((left, right) => left - right);
}
