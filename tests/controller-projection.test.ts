import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ControlPlaneService } from "../src/main/control-plane/control-plane-service";
import { DirectDatabaseClient } from "../src/main/storage/database-client";
import { MAX_INLINE_EVENT_PAYLOAD_BYTES, type ControlPlaneEvent } from "../src/shared/control-plane-contracts";
import type { Conversation } from "../src/shared/contracts";

function conversation(): Conversation {
  return {
    id: "conversation-1",
    title: "Restart projection",
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoning: "medium",
    sandboxMode: "workspace-write",
    allowCommands: true,
    projectMode: "project",
    workingDirectory: "/tmp/project",
    messages: [],
    activities: [],
    selectedAgentIds: [],
    agentRuns: [],
    crewCommunications: [],
    status: "running",
    createdAt: 1,
    updatedAt: 1,
  };
}

function event(sequence: number, type: ControlPlaneEvent["type"], payload: unknown): ControlPlaneEvent {
  return {
    id: `event-${sequence}`,
    aggregateId: "conversation-1",
    conversationId: "conversation-1",
    runId: "run-1",
    sequence,
    timestamp: sequence,
    source: "test",
    type,
    schemaVersion: 1,
    payload,
  };
}

describe("controller projection boundary", () => {
  test("rebuilds the same bounded projection from persisted events and publishes incremental changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-projection-"));
    const pathname = join(directory, "control-plane.sqlite3");
    const database = new DirectDatabaseClient(pathname);
    await database.initialize();
    const service = new ControlPlaneService(database);
    await service.initialize();
    const changes: unknown[] = [];
    service.subscribe((change) => changes.push(change));

    await service.append(event(1, "conversation.snapshot", { conversation: conversation() }));
    await service.append(event(2, "provider.activity", { activity: { id: "plan", kind: "plan", label: "Plan", status: "completed", createdAt: 2 } }));
    const live = service.conversationProjection("conversation-1");
    const storedProjection = JSON.parse((await database.listConversationProjections())["conversation-1"]!);
    expect(changes).toHaveLength(2);
    expect(changes).not.toContainEqual(expect.objectContaining({ database }));
    expect(storedProjection).toEqual(live);
    await database.close();

    const reopened = new DirectDatabaseClient(pathname);
    await reopened.initialize();
    const rebuilt = new ControlPlaneService(reopened);
    await rebuilt.initialize({ rebuild: true });
    expect(rebuilt.conversationProjection("conversation-1")).toEqual(live);
    await reopened.close();
  });

  test("replaces oversized payloads with content-addressed artifact references", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-projection-"));
    const database = new DirectDatabaseClient(join(directory, "control-plane.sqlite3"));
    await database.initialize();
    const service = new ControlPlaneService(database);
    await service.initialize();
    await service.append(event(1, "conversation.snapshot", { conversation: conversation() }));

    const largeText = "x".repeat(MAX_INLINE_EVENT_PAYLOAD_BYTES + 10_000);
    await service.append(event(2, "run.final", { message: { id: "large", role: "assistant", content: largeText, createdAt: 2, provider: "codex" } }));
    const live = service.conversationProjection("conversation-1");
    const stored = (await database.listEvents()).map((value) => JSON.parse(value) as ControlPlaneEvent);

    expect(stored[1]?.payload).toEqual(expect.objectContaining({ artifact: expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/), byteSize: expect.any(Number) }) }));
    expect(JSON.stringify(stored[1]).length).toBeLessThan(MAX_INLINE_EVENT_PAYLOAD_BYTES);
    expect((await database.inspect()).tables).toContain("event_artifacts");
    await database.close();

    const reopened = new DirectDatabaseClient(join(directory, "control-plane.sqlite3"));
    await reopened.initialize();
    const rebuilt = new ControlPlaneService(reopened);
    await rebuilt.initialize({ rebuild: true });
    expect(rebuilt.conversationProjection("conversation-1")).toEqual(live);
    await reopened.close();
  });
});
