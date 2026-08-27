import { mkdtemp } from "node:fs/promises";
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
});
