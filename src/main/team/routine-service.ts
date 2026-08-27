import { randomUUID } from "node:crypto";
import type { AgentRoutine } from "../../shared/contracts";
import type { TeamRepository } from "./agent-runtime-service";

const weekday = new Map([["Sun", 0], ["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6]]);

function localParts(timestamp: number, timeZone: string): { date: string; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")), minute: Number(part("minute")), weekday: weekday.get(part("weekday")) ?? -1 };
}

export function nextRoutineFire(schedule: AgentRoutine["schedule"], after: number): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.localTime)) throw new Error("Routine local time is invalid");
  try { new Intl.DateTimeFormat("en-US", { timeZone: schedule.timeZone }).format(after); } catch { throw new Error("Routine timezone is invalid"); }
  const [hour, minute] = schedule.localTime.split(":").map(Number) as [number, number];
  const days = schedule.daysOfWeek ? new Set(schedule.daysOfWeek) : undefined;
  let candidate = Math.floor(after / 60_000) * 60_000 + 60_000;
  const limit = candidate + 370 * 24 * 60 * 60_000;
  while (candidate <= limit) {
    const local = localParts(candidate, schedule.timeZone);
    if (local.hour === hour && local.minute === minute && (!days || days.has(local.weekday))) return candidate;
    candidate += 60_000;
  }
  throw new Error("Routine has no fire time within one year");
}

export class RoutineService {
  constructor(private readonly repository: TeamRepository, private readonly now = Date.now) {}

  async create(input: Omit<AgentRoutine, "id" | "version" | "nextFireAt" | "lastOccurrenceKey" | "createdAt" | "updatedAt">): Promise<AgentRoutine> {
    const now = this.now();
    const routine: AgentRoutine = { ...structuredClone(input), id: `routine:${randomUUID()}`, version: 1, nextFireAt: nextRoutineFire(input.schedule, now), createdAt: now, updatedAt: now };
    await this.repository.mutate((state) => { state.routines.push(routine); });
    return structuredClone(routine);
  }

  async due(now = this.now()): Promise<Array<{ routine: AgentRoutine; occurrenceKey: string }>> {
    const due: Array<{ routine: AgentRoutine; occurrenceKey: string }> = [];
    await this.repository.mutate((state) => {
      for (const routine of state.routines.filter((item) => item.active && item.nextFireAt <= now)) {
        const local = localParts(routine.nextFireAt, routine.schedule.timeZone);
        const occurrenceKey = `${routine.id}:${local.date}:${routine.schedule.localTime}`;
        if (routine.lastOccurrenceKey !== occurrenceKey) due.push({ routine: structuredClone(routine), occurrenceKey });
        routine.lastOccurrenceKey = occurrenceKey;
        routine.nextFireAt = nextRoutineFire(routine.schedule, Math.max(now, routine.nextFireAt));
        routine.updatedAt = now;
      }
    });
    return due;
  }

  assertRetrySafe(input: { ambiguousExternalSideEffect: boolean; idempotencyKey?: string; operatorDecision?: "retry" | "cancel" }): void {
    if (input.ambiguousExternalSideEffect && !input.idempotencyKey && !input.operatorDecision) throw new Error("Ambiguous external side effect requires an idempotency key or operator decision");
  }
}
