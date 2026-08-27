import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { assertSqliteRuntime, DirectDatabaseClient } from "../src/main/storage/database-client";

describe("control-plane database", () => {
  test("stores snapshots transactionally and exposes the current schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-database-"));
    const client = new DirectDatabaseClient(join(directory, "control-plane.sqlite3"));

    await client.initialize();
    await client.writeSnapshot('{"version":2,"marker":"first"}');

    expect(await client.readSnapshot()).toBe('{"version":2,"marker":"first"}');
    expect(await client.inspect()).toMatchObject({ schemaVersion: 3, journalMode: "wal" });
    expect((await client.inspect()).tables).toEqual(expect.arrayContaining([
      "agents",
      "conversations",
      "conversation_projections",
      "devices",
      "event_artifacts",
      "event_diagnostics",
      "events",
      "messages",
      "policies",
      "runs",
      "secrets_metadata",
      "settings",
      "task_attempts",
      "task_checkpoints",
      "task_edges",
      "task_goals",
      "task_graph_state",
      "task_leases",
      "task_messages",
      "tasks",
    ]));

    await client.close();
  });

  test("serializes concurrent snapshot writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-database-"));
    const client = new DirectDatabaseClient(join(directory, "control-plane.sqlite3"));
    await client.initialize();

    await Promise.all(Array.from({ length: 12 }, (_, index) => client.writeSnapshot(JSON.stringify({ index }))));

    expect(await client.readSnapshot()).toBe('{"index":11}');
    await client.close();
  });

  test("fails with a useful message below the supported Node floor", () => {
    expect(() => assertSqliteRuntime("22.12.0")).toThrow(/Node\.js 22\.13 or newer/);
    expect(() => assertSqliteRuntime("22.13.0")).not.toThrow();
    expect(() => assertSqliteRuntime("24.0.0")).not.toThrow();
  });
});
