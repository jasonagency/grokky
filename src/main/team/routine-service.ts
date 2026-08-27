import { randomUUID } from "node:crypto";
import type { AgentRoutine } from "../../shared/contracts";
import { validateTaskGoalDraft } from "../control-plane/task-graph";
import type { TeamRepository } from "./agent-runtime-service";
import { nextRoutineFire, routineLocalParts } from "../../shared/routine-schedule";
export { nextRoutineFire } from "../../shared/routine-schedule";

export class RoutineService {
  constructor(private readonly repository: TeamRepository, private readonly now = Date.now) {}

  async create(input: Omit<AgentRoutine, "id" | "version" | "nextFireAt" | "lastOccurrenceKey" | "createdAt" | "updatedAt">): Promise<AgentRoutine> {
    const now = this.now();
    const template = validateTaskGoalDraft(input.template);
    const routine: AgentRoutine = { ...structuredClone(input), template, id: `routine:${randomUUID()}`, version: 1, nextFireAt: nextRoutineFire(input.schedule, now), createdAt: now, updatedAt: now };
    await this.repository.mutate((state) => { state.routines.push(routine); });
    return structuredClone(routine);
  }

  async due(now = this.now()): Promise<Array<{ routine: AgentRoutine; occurrenceKey: string }>> {
    return this.repository.snapshot().routines
      .filter((routine) => routine.active && routine.nextFireAt <= now)
      .flatMap((routine) => {
        const local = routineLocalParts(routine.nextFireAt, routine.schedule.timeZone);
        const occurrenceKey = `${routine.id}:${local.date}:${routine.schedule.localTime}`;
        return routine.lastOccurrenceKey === occurrenceKey ? [] : [{ routine: structuredClone(routine), occurrenceKey }];
      });
  }

  async acknowledge(routineId: string, occurrenceKey: string, now = this.now()): Promise<void> {
    await this.repository.mutate((state) => {
      const routine = state.routines.find((item) => item.id === routineId);
      if (!routine) throw new Error("Agent routine was not found");
      if (routine.lastOccurrenceKey === occurrenceKey) return;
      const local = routineLocalParts(routine.nextFireAt, routine.schedule.timeZone);
      const expected = `${routine.id}:${local.date}:${routine.schedule.localTime}`;
      if (occurrenceKey !== expected) throw new Error("Routine occurrence is stale");
      routine.lastOccurrenceKey = occurrenceKey;
      routine.nextFireAt = nextRoutineFire(routine.schedule, Math.max(now, routine.nextFireAt));
      routine.updatedAt = now;
    });
  }

  async alignRemote(routineId: string, value: { nextFireAt: number; lastOccurrenceKey?: string }, now = this.now()): Promise<void> {
    if (!Number.isSafeInteger(value.nextFireAt) || value.nextFireAt < 0) throw new Error("Remote routine fire time is invalid");
    const existing = this.repository.snapshot().routines.find((routine) => routine.id === routineId);
    if (!existing) throw new Error("Agent routine was not found");
    if (existing.nextFireAt === value.nextFireAt && existing.lastOccurrenceKey === value.lastOccurrenceKey) return;
    await this.repository.mutate((state) => { const routine = state.routines.find((item) => item.id === routineId); if (!routine) throw new Error("Agent routine was not found"); routine.nextFireAt = value.nextFireAt; routine.lastOccurrenceKey = value.lastOccurrenceKey; routine.updatedAt = now; });
  }

  assertRetrySafe(input: { ambiguousExternalSideEffect: boolean; idempotencyKey?: string; operatorDecision?: "retry" | "cancel" }): void {
    if (input.ambiguousExternalSideEffect && !input.idempotencyKey && !input.operatorDecision) throw new Error("Ambiguous external side effect requires an idempotency key or operator decision");
  }
}
