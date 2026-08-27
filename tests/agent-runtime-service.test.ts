import { describe, expect, test } from "vitest";
import { AgentRuntimeService, TeamRepository } from "../src/main/team/agent-runtime-service";
import { teamStore } from "./support/team-store";
import { RoutineService } from "../src/main/team/routine-service";

const profile = { id: "agent:builder", name: "builder", description: "Builds", developerInstructions: "Build carefully", scope: "project" as const, builtIn: false, model: "gpt-5.6-terra", reasoning: "high" as const, sandboxMode: "workspace-write" as const };

describe("AgentRuntimeService", () => {
  test("imports TOML-compatible roles and restores session, cursor, and reviewed state after restart", async () => {
    const store = teamStore();
    const first = new AgentRuntimeService(new TeamRepository(store.database), () => 10);
    await first.initialize();
    await first.importDefinitions([profile]);
    await first.rememberSession(profile.id, "codex-app-server", "thread-123", "mail-9");

    const restarted = new AgentRuntimeService(new TeamRepository(store.database), () => 20);
    await restarted.initialize();
    expect(restarted.snapshot().agents[0]).toMatchObject({ profile: { model: "gpt-5.6-terra", reasoning: "high", sandboxMode: "workspace-write" }, harnessPreference: "codex-app-server", sessionReferences: { "codex-app-server": "thread-123" }, mailboxCursor: "mail-9" });
  });

  test("duplicates profile but not history or active session ownership", async () => {
    const store = teamStore();
    const service = new AgentRuntimeService(new TeamRepository(store.database), () => 10);
    await service.initialize();
    await service.importDefinitions([profile]);
    await service.rememberSession(profile.id, "pi", "session-secret");
    await new RoutineService(service.repository, () => 10).create({ ownerAgentId: profile.id, name: "Daily", template: { id: "daily", title: "Daily", objective: "Daily", nodes: [] }, schedule: { localTime: "09:00", timeZone: "UTC" }, targetHostId: "local", budgetUsd: 1, approvalBoundary: "always", active: true });
    const copy = await service.duplicate(profile.id, "builder_copy");
    expect(copy.profile.name).toBe("builder_copy");
    expect(copy.sessionReferences).toEqual({});
    expect(copy.mailboxCursor).toBeUndefined();
    expect(service.snapshot().routines.filter((routine) => routine.ownerAgentId === copy.id)).toHaveLength(1);
  });
});
