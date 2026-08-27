import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AgentWorkspace } from "../src/renderer/src/features/team/AgentWorkspace";

describe("AgentWorkspace", () => {
  test("links persistent identity, mailbox handoff, reviewable memory, and routines", () => {
    const markup = renderToStaticMarkup(<AgentWorkspace onAcknowledge={() => undefined} onReviewMemory={() => undefined} onCreateRoutine={() => undefined} onAgentAction={() => undefined} onDuplicate={() => undefined} team={{ revision: 1, agents: [{ id: "agent:a", profile: { id: "agent:a", name: "builder", description: "Builds", developerInstructions: "Build", scope: "project", builtIn: false }, profileHash: "hash", status: "active", pinned: false, harnessPreference: "pi", sessionReferences: { pi: "session" }, notificationPolicy: "attention", createdAt: 1, updatedAt: 1 }], messages: [{ id: "mail", threadId: "task", senderId: "lead", receiverIds: ["agent:a"], taskId: "task", kind: "handoff", content: "Own verification", acknowledgedBy: [], createdAt: 1 }], memories: [{ id: "memory", agentId: "agent:a", kind: "fact", content: "Use npm test", sourceReferences: ["package.json"], reviewStatus: "proposed", createdAt: 1 }], routines: [] }} />);
    expect(markup).toContain('aria-label="Persistent agent workspace"');
    expect(markup).toContain("Own verification");
    expect(markup).toContain("Use npm test");
    expect(markup).not.toContain("No active harness session");
  });
});
