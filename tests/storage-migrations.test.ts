import { access, mkdtemp, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DirectDatabaseClient } from "../src/main/storage/database-client";

describe("storage migrations", () => {
  test("are forward-only and safe to apply repeatedly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-migrations-"));
    const pathname = join(directory, "control-plane.sqlite3");

    const first = new DirectDatabaseClient(pathname);
    await first.initialize();
    await first.writeSnapshot('{"version":2,"preserved":true}');
    await first.close();

    const reopened = new DirectDatabaseClient(pathname);
    await reopened.initialize();

    expect(await reopened.readSnapshot()).toBe('{"version":2,"preserved":true}');
    expect((await reopened.inspect()).appliedMigrations).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await reopened.close();
  });

  test("rolls back a failed write without damaging the prior snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-migrations-"));
    const database = new DirectDatabaseClient(join(directory, "control-plane.sqlite3"));
    await database.initialize();
    await database.writeSnapshot('{"version":2,"preserved":true}');

    await expect(database.writeSnapshot("not-json")).rejects.toThrow();
    expect(await database.readSnapshot()).toBe('{"version":2,"preserved":true}');
    await database.close();
  });

  test("keeps a pre-migration backup and recovery path when a migration fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-migrations-"));
    const pathname = join(directory, "control-plane.sqlite3");
    const seeded = new DatabaseSync(pathname);
    seeded.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, 1), (2, 1), (3, 1), (4, 1), (5, 1), (6, 1), (7, 1);
      CREATE TABLE remote_state (wrong_column TEXT) STRICT;
    `);
    seeded.close();

    const database = new DirectDatabaseClient(pathname);
    await expect(database.initialize()).rejects.toThrow("pre-migration database is preserved");
    const backupPath = `${pathname}.pre-migration-backup`;
    await expect(access(backupPath)).resolves.toBeUndefined();
    const firstBackup = await readFile(backupPath);

    const retry = new DirectDatabaseClient(pathname);
    await expect(retry.initialize()).rejects.toThrow("pre-migration database is preserved");
    expect(await readFile(backupPath)).toEqual(firstBackup);
  });
});
