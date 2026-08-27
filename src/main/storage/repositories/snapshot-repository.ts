import type { PersistentState } from "../../state-store";

export function encodePersistentSnapshot(state: PersistentState): string {
  return JSON.stringify(state);
}

export function decodePersistentSnapshot(snapshot: string): unknown {
  return JSON.parse(snapshot) as unknown;
}
