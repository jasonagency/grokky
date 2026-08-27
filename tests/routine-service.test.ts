import { describe, expect, test } from "vitest";
import { TeamRepository } from "../src/main/team/agent-runtime-service";
import { nextRoutineFire, RoutineService } from "../src/main/team/routine-service";
import { teamStore } from "./support/team-store";

describe("RoutineService", () => {
  test("calculates timezone fire times across daylight-saving changes", () => {
    const beforeSpring = Date.parse("2026-03-08T08:00:00Z");
    const spring = nextRoutineFire({ localTime: "09:00", timeZone: "America/Los_Angeles" }, beforeSpring);
    expect(new Date(spring).toISOString()).toBe("2026-03-08T16:00:00.000Z");
    const beforeFall = Date.parse("2026-11-01T07:00:00Z");
    const fall = nextRoutineFire({ localTime: "09:00", timeZone: "America/Los_Angeles" }, beforeFall);
    expect(new Date(fall).toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });

  test("emits at most one occurrence across repeated scheduler passes and restart-safe state", async () => {
    let now = Date.parse("2026-01-01T16:59:00Z");
    const store = teamStore();
    const repository = new TeamRepository(store.database);
    await repository.initialize();
    const routines = new RoutineService(repository, () => now);
    const routine = await routines.create({ ownerAgentId: "agent:a", name: "Daily audit", template: { id: "goal", title: "Audit", objective: "Audit", nodes: [] }, schedule: { localTime: "09:00", timeZone: "America/Los_Angeles" }, targetHostId: "local", budgetUsd: 1, approvalBoundary: "external-side-effects", active: true });
    now = routine.nextFireAt;
    expect(await routines.due()).toHaveLength(1);
    expect(await routines.due()).toHaveLength(0);
    expect(() => routines.assertRetrySafe({ ambiguousExternalSideEffect: true })).toThrow("idempotency key or operator decision");
  });
});
