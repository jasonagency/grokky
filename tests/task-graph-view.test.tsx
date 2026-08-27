import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { TaskGraphView } from "../src/renderer/src/features/tasks/TaskGraphView";
import type { TaskGraphSnapshot } from "../src/shared/control-plane-contracts";

const graph: TaskGraphSnapshot = {
  revision: 3,
  goals: [{ id: "goal", title: "Ship U4", objective: "Make the task graph durable", status: "active", createdAt: 1, updatedAt: 3 }],
  tasks: [
    {
      id: "root",
      goalId: "goal",
      title: "Build scheduler",
      description: "Lease ready work",
      status: "succeeded",
      priority: 5,
      dependsOn: [],
      blockerChain: [],
      assignment: {},
      maxAttempts: 3,
      attempts: [],
      checkpoints: [],
      messages: [],
      outcome: { summary: "Done", completedAt: 2 },
      createdAt: 1,
      updatedAt: 2,
    },
    {
      id: "child",
      goalId: "goal",
      title: "Render graph",
      description: "Accessible queue",
      status: "queued",
      priority: 4,
      dependsOn: ["root"],
      blockerChain: [],
      assignment: { agentId: "designer" },
      maxAttempts: 3,
      attempts: [{ id: "attempt-1", taskId: "child", number: 1, status: "interrupted", startedAt: 2, completedAt: 3, recovery: "expired-lease" }],
      checkpoints: [],
      messages: [],
      createdAt: 1,
      updatedAt: 3,
    },
  ],
};

describe("task graph view", () => {
  test("renders a keyboard-readable queue with dependencies, attempts, and attention state", () => {
    const markup = renderToStaticMarkup(<TaskGraphView graph={graph} selectedTaskId="child" onSelect={() => undefined} />);

    expect(markup).toContain('aria-label="Task graph and queue"');
    expect(markup).toContain('role="list"');
    expect(markup.match(/role="listitem"/g)).toHaveLength(2);
    expect(markup.match(/<button/g)).toHaveLength(2);
    expect(markup).toContain("Render graph");
    expect(markup).toContain("Depends on Build scheduler");
    expect(markup).toContain("1 attempt");
    expect(markup).toContain("Needs attention");
  });
});
