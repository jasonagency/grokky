import { describe, expect, test } from "vitest";
import { localBackgroundWork } from "../src/main/app-lifecycle";

describe("application background lifecycle", () => {
  test("keeps the process alive only for active work owned by this desktop", () => {
    const conversations = [{ id: "chat", status: "running" as const }];
    const tasks = [
      { id: "local-queued", status: "queued" as const, assignment: {} },
      { id: "remote-running", status: "running" as const, assignment: { targetHostId: "remote" } },
      { id: "done", status: "succeeded" as const, assignment: {} },
    ];

    expect(localBackgroundWork(conversations, tasks, "local")).toEqual({
      conversationIds: ["chat"],
      taskIds: ["local-queued"],
    });
    expect(localBackgroundWork([], [tasks[1]!], "local")).toEqual({ conversationIds: [], taskIds: [] });
  });
});
