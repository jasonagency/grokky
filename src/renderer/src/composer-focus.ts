import type { RunStatus } from "../../shared/contracts";

export interface ComposerFocusState {
  restoreAfterRun: boolean;
  wasRunning: boolean;
}

export type ComposerFocusEvent =
  | { type: "submitted" }
  | { type: "pointer-away" }
  | { type: "status"; status: RunStatus }
  | { type: "reset" };

export function canSubmitComposer(draft: string, status: RunStatus, submissionPending: boolean): boolean {
  return Boolean(draft.trim()) && status !== "running" && !submissionPending;
}

export function composerFocusTransition(
  state: ComposerFocusState,
  event: ComposerFocusEvent,
): { state: ComposerFocusState; focus: boolean } {
  if (event.type === "reset") return { state: { restoreAfterRun: false, wasRunning: false }, focus: false };
  if (event.type === "submitted") return { state: { ...state, restoreAfterRun: true }, focus: false };
  if (event.type === "pointer-away") return { state: { ...state, restoreAfterRun: false }, focus: false };
  if (event.status === "running") return { state: { ...state, wasRunning: true }, focus: false };
  if (!state.wasRunning) return { state, focus: false };
  return {
    state: { restoreAfterRun: false, wasRunning: false },
    focus: state.restoreAfterRun,
  };
}
