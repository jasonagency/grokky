import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { LiveControls } from "../src/renderer/src/features/steering/LiveControls";
import type { TaskNode } from "../src/shared/control-plane-contracts";

const task: TaskNode = { id: "task", goalId: "goal", title: "Ship", description: "Ship safely", status: "running", priority: 2, dependsOn: [], blockerChain: [], assignment: { harnessId: "codex-app-server" }, maxAttempts: 3, attempts: [], checkpoints: [], messages: [], createdAt: 1, updatedAt: 2 };

describe("live controls", () => {
  test("renders task controls and durable delivery state", () => {
    const markup = renderToStaticMarkup(<LiveControls task={task} busy={false} onControl={() => undefined} commands={[{ id: "command", taskId: "task", harnessId: "codex-app-server", type: "redirect", message: "Use main", idempotencyKey: "one", status: "acknowledged", createdAt: 1, updatedAt: 2 }]} />);
    expect(markup).toContain('aria-label="Live steering controls"');
    expect(markup).toContain("Pause");
    expect(markup).toContain("Stop");
    expect(markup).toContain("acknowledged");
  });
});
