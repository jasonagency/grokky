import { describe, expect, test } from "vitest";
import { canSubmitComposer, composerFocusTransition, type ComposerFocusState } from "../src/renderer/src/composer-focus";

const idle: ComposerFocusState = { restoreAfterRun: false, wasRunning: false };

describe("composer focus retention", () => {
  test("returns focus after a submitted run completes", () => {
    const submitted = composerFocusTransition(idle, { type: "submitted" });
    const running = composerFocusTransition(submitted.state, { type: "status", status: "running" });
    const completed = composerFocusTransition(running.state, { type: "status", status: "idle" });

    expect(completed.focus).toBe(true);
    expect(completed.state).toEqual(idle);
  });

  test("does not steal focus back after the user clicks away", () => {
    const submitted = composerFocusTransition(idle, { type: "submitted" });
    const running = composerFocusTransition(submitted.state, { type: "status", status: "running" });
    const clickedAway = composerFocusTransition(running.state, { type: "pointer-away" });
    const completed = composerFocusTransition(clickedAway.state, { type: "status", status: "idle" });

    expect(completed.focus).toBe(false);
    expect(completed.state).toEqual(idle);
  });

  test("ignores a duplicate submission before running status arrives", () => {
    expect(canSubmitComposer("next", "idle", false)).toBe(true);
    expect(canSubmitComposer("next", "idle", true)).toBe(false);
  });

  test("reset and idle-without-run never request focus", () => {
    expect(composerFocusTransition(idle, { type: "reset" })).toEqual({ state: idle, focus: false });
    expect(composerFocusTransition(idle, { type: "status", status: "idle" })).toEqual({ state: idle, focus: false });
  });
});
