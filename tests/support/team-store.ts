import type { TeamStateSnapshot } from "../../src/shared/contracts";

export function teamStore(initial?: TeamStateSnapshot) {
  let value = initial ? JSON.stringify(initial) : null;
  return {
    database: {
      readTeamState: async () => value,
      writeTeamState: async (next: string) => { value = next; },
    },
    snapshot: () => value ? JSON.parse(value) as TeamStateSnapshot : undefined,
  };
}
