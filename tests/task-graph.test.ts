import { describe, expect, test } from "vitest";
import { TaskGraph } from "../src/main/control-plane/task-graph";

describe("task graph", () => {
  test("rejects a cycle before mutating the graph", () => {
    const graph = TaskGraph.empty();

    expect(() => graph.addGoal({
      id: "goal-cycle",
      title: "Invalid graph",
      objective: "Prove cycles cannot enter durable state",
      nodes: [
        { id: "task-a", title: "A", dependsOn: ["task-b"] },
        { id: "task-b", title: "B", dependsOn: ["task-a"] },
      ],
    }, 100)).toThrow("cycle");

    expect(graph.snapshot()).toMatchObject({ revision: 0, goals: [], tasks: [] });
  });

  test("blocks descendants with a causal chain until the failed dependency is retried", () => {
    const graph = TaskGraph.empty();
    graph.addGoal({
      id: "goal-release",
      title: "Release",
      objective: "Build then publish",
      nodes: [
        { id: "build", title: "Build" },
        { id: "test", title: "Test", dependsOn: ["build"] },
        { id: "publish", title: "Publish", dependsOn: ["test"] },
      ],
    }, 100);

    graph.markFailed("build", { summary: "Compiler failed", completedAt: 110 }, 110);

    expect(graph.task("test")).toMatchObject({ status: "blocked", blockerChain: ["build"] });
    expect(graph.task("publish")).toMatchObject({ status: "blocked", blockerChain: ["build", "test"] });

    graph.applyAction("build", { type: "retry" }, 120);

    expect(graph.task("build").status).toBe("queued");
    expect(graph.task("test")).toMatchObject({ status: "blocked", blockerChain: ["build"] });
    expect(graph.task("publish")).toMatchObject({ status: "blocked", blockerChain: ["build", "test"] });
  });

  test("rewires dependencies through the same validated action path", () => {
    const graph = TaskGraph.empty();
    graph.addGoal({
      id: "goal-rewire",
      title: "Rewire",
      objective: "Change a dependency safely",
      nodes: [
        { id: "first", title: "First" },
        { id: "second", title: "Second", dependsOn: ["first"] },
      ],
    }, 100);

    expect(() => graph.applyAction("first", { type: "rewire", dependsOn: ["second"] }, 110)).toThrow("cycle");

    expect(graph.task("first").dependsOn).toEqual([]);
    expect(graph.task("second").dependsOn).toEqual(["first"]);
    expect(graph.snapshot().revision).toBe(1);
  });

  test("rejects rewiring across goal boundaries without mutation", () => {
    const graph = TaskGraph.empty();
    graph.addGoal({ id: "goal-a", title: "Goal A", objective: "Keep A isolated", nodes: [{ id: "task-a", title: "Task A" }] }, 100);
    graph.addGoal({ id: "goal-b", title: "Goal B", objective: "Keep B isolated", nodes: [{ id: "task-b", title: "Task B" }] }, 110);

    expect(() => graph.applyAction("task-a", { type: "rewire", dependsOn: ["task-b"] }, 120)).toThrow("same goal");

    expect(graph.task("task-a").dependsOn).toEqual([]);
    expect(graph.snapshot().revision).toBe(2);
  });
});
