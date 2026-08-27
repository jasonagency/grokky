export interface RoutineSchedule {
  localTime: string;
  timeZone: string;
  daysOfWeek?: number[];
}

const weekday = new Map([["Sun", 0], ["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6]]);

export function routineLocalParts(timestamp: number, timeZone: string): { date: string; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")), minute: Number(part("minute")), weekday: weekday.get(part("weekday")) ?? -1 };
}

export function validateRoutineSchedule(schedule: RoutineSchedule, at: number): void {
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("Routine schedule cursor is invalid");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.localTime)) throw new Error("Routine local time is invalid");
  if (schedule.daysOfWeek && (!Array.isArray(schedule.daysOfWeek) || !schedule.daysOfWeek.length || schedule.daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) throw new Error("Routine weekdays are invalid");
  try { new Intl.DateTimeFormat("en-US", { timeZone: schedule.timeZone }).format(at); } catch { throw new Error("Routine timezone is invalid"); }
}

export function nextRoutineFire(schedule: RoutineSchedule, after: number): number {
  validateRoutineSchedule(schedule, after);
  const [hour, minute] = schedule.localTime.split(":").map(Number) as [number, number];
  const days = schedule.daysOfWeek ? new Set(schedule.daysOfWeek) : undefined;
  let candidate = Math.floor(after / 60_000) * 60_000 + 60_000;
  const limit = candidate + 370 * 24 * 60 * 60_000;
  while (candidate <= limit) {
    const local = routineLocalParts(candidate, schedule.timeZone);
    if (local.hour === hour && local.minute === minute && (!days || days.has(local.weekday))) return candidate;
    candidate += 60_000;
  }
  throw new Error("Routine has no fire time within one year");
}
