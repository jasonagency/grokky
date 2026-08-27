import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { defaultPersistentState, noProjectDirectory, sqlitePathForLegacy, StateStore } from "../src/main/state-store";
import type { ControlPlaneDatabase } from "../src/main/storage/database-types";

describe("StateStore", () => {
  test("writes a SQLite snapshot and reads it back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-state-"));
    const pathname = join(directory, "state.json");
    const store = new StateStore(pathname, directory);
    const state = defaultPersistentState(directory);
    state.settings.theme = "dark";
    state.settings.accentPalette = "electric-blue";
    state.settings.updateChannel = "beta";
    await store.save(state);
    expect((await store.load()).settings.theme).toBe("dark");
    expect((await store.load()).settings.accentPalette).toBe("electric-blue");
    expect((await store.load()).settings.updateChannel).toBe("beta");
    expect((await store.load()).computerAccess).toMatchObject({ enabled: true, grants: { files: "allow", commands: "ask" } });
    await store.close();
  });

  test.skipIf(process.platform === "win32")("restricts SQLite snapshot permissions on POSIX", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-state-"));
    const pathname = join(directory, "state.json");
    const store = new StateStore(pathname, directory);
    await store.load();
    expect((await stat(sqlitePathForLegacy(pathname))).mode & 0o777).toBe(0o600);
    await store.close();
  });

  test("recovers from unreadable state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-state-"));
    const store = new StateStore(join(directory, "missing.json"), directory);
    expect((await store.load()).conversations).toEqual([]);
    await store.close();
  });

  test("does not hide database initialization failures behind empty state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-state-"));
    const initializationError = new Error("migration failed");
    const database: ControlPlaneDatabase = {
      initialize: () => Promise.reject(initializationError),
      readSnapshot: () => Promise.resolve(null),
      writeSnapshot: () => Promise.resolve(),
      readTaskGraph: () => Promise.resolve(null),
      writeTaskGraph: () => Promise.resolve(),
      readWorkspaceState: () => Promise.resolve(null),
      writeWorkspaceState: () => Promise.resolve(),
      readControlRuntime: () => Promise.resolve(null),
      writeControlRuntime: () => Promise.resolve(),
      readQualityState: () => Promise.resolve(null),
      writeQualityState: () => Promise.resolve(),
      readTeamState: () => Promise.resolve(null),
      writeTeamState: () => Promise.resolve(),
      readRemoteState: () => Promise.resolve(null),
      writeRemoteState: () => Promise.resolve(),
      importLegacySnapshot: () => Promise.resolve(false),
      appendEvent: () => Promise.resolve({ status: "appended", sequence: 1 }),
      listEvents: () => Promise.resolve([]),
      listEventDiagnostics: () => Promise.resolve([]),
      listConversationProjections: () => Promise.resolve({}),
      readEventArtifact: () => Promise.resolve(null),
      deleteExpiredEventArtifacts: () => Promise.resolve(0),
      inspect: () => Promise.resolve({ schemaVersion: 0, appliedMigrations: [], journalMode: "unknown", tables: [] }),
      close: () => Promise.resolve(),
    };
    const store = new StateStore(join(directory, "state.json"), directory, { database });

    await expect(store.load()).rejects.toThrow("migration failed");
  });

  test("migrates old conversations and removes the benign skills budget notice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-state-"));
    const pathname = join(directory, "state.json");
    await writeFile(pathname, JSON.stringify({
      version: 1,
      activeConversationId: "old-chat",
      settings: { defaultWorkingDirectory: directory, multiAgentEnabled: true, maxAgentThreads: 99 },
      conversations: [{
        id: "old-chat",
        title: "Old chat",
        workingDirectory: directory,
        messages: [],
        activities: [{ id: "notice", detail: "Skill descriptions were shortened to fit the skills context budget." }],
        agentRuns: [{ id: "child", operationId: "spawn", threadId: "thread", name: "tester", task: "Old interrupted work", status: "working", createdAt: 1, updatedAt: 2 }],
        crewCommunications: [{ id: "report", operationId: "wait", tool: "wait", kind: "report", senderThreadId: "thread", senderName: "tester", receiverThreadId: "lead", receiverName: "Grokky lead", content: "Stored report", status: "completed", createdAt: 2 }],
        createdAt: 1,
        updatedAt: 2,
      }],
    }));
    const store = new StateStore(pathname, directory);
    const state = await store.load();
    expect(state.conversations[0]).toMatchObject({ projectMode: "none", workingDirectory: noProjectDirectory(directory), selectedAgentIds: [], agentRuns: [{ name: "tester", status: "stopped" }], crewCommunications: [{ receiverName: "PuckBot lead", content: "Stored report" }], activities: [] });
    expect(state.settings).toMatchObject({ defaultWorkingDirectory: noProjectDirectory(directory), recentWorkingDirectories: [], accentPalette: "lime", maxAgentThreads: 8, defaultSubagentModel: "", defaultSubagentReasoning: "", interruptAgentMessage: true, webSearchEnabled: true });
    expect(state.computerAccess.activeDeviceId).toBe(state.computerAccess.localDeviceId);
    await store.close();
  });
});
