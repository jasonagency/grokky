import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ControlPlaneService } from "../src/main/control-plane/control-plane-service";
import { DirectDatabaseClient } from "../src/main/storage/database-client";
import type { ControlPlaneEvent } from "../src/shared/control-plane-contracts";

function event(patch: Partial<ControlPlaneEvent> = {}): ControlPlaneEvent {
  return {
    id: "event-1",
    aggregateId: "conversation-1",
    conversationId: "conversation-1",
    runId: "run-1",
    sequence: 1,
    timestamp: 1,
    source: "test",
    type: "run.started",
    schemaVersion: 1,
    payload: {},
    ...patch,
  };
}

describe("control-plane event append", () => {
  test("is idempotent by event ID and does not advance aggregate sequence twice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-events-"));
    const database = new DirectDatabaseClient(join(directory, "control-plane.sqlite3"));
    await database.initialize();
    const service = new ControlPlaneService(database);
    await service.initialize();

    expect((await service.append(event())).status).toBe("appended");
    expect((await service.append(event())).status).toBe("duplicate");
    expect(await service.nextSequence("conversation-1")).toBe(2);
    expect(await database.listEvents()).toHaveLength(1);
    await database.close();
  });

  test("rejects an out-of-order aggregate sequence and records one bounded diagnostic", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-events-"));
    const database = new DirectDatabaseClient(join(directory, "control-plane.sqlite3"));
    await database.initialize();
    const service = new ControlPlaneService(database);
    await service.initialize();

    const result = await service.append(event({ id: "event-gap", sequence: 3 }));

    expect(result).toMatchObject({ status: "rejected", expectedSequence: 1, actualSequence: 3 });
    expect(await database.listEvents()).toEqual([]);
    expect(await database.listEventDiagnostics()).toEqual([
      expect.objectContaining({ eventId: "event-gap", aggregateId: "conversation-1", code: "aggregate_sequence_gap" }),
    ]);
    await database.close();
  });
});
