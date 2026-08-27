import { describe, expect, test } from "vitest";
import { EventProjector } from "../src/main/control-plane/event-projector";
import type { ControlPlaneEvent } from "../src/shared/control-plane-contracts";
import type { Conversation } from "../src/shared/contracts";

function conversation(): Conversation {
  return {
    id: "conversation-1",
    title: "Projection test",
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoning: "medium",
    sandboxMode: "workspace-write",
    allowCommands: true,
    projectMode: "project",
    workingDirectory: "/tmp/project",
    messages: [],
    activities: [],
    selectedAgentIds: [],
    agentRuns: [],
    crewCommunications: [],
    status: "running",
    createdAt: 1,
    updatedAt: 1,
  };
}

function event(sequence: number, type: ControlPlaneEvent["type"], payload: unknown): ControlPlaneEvent {
  return {
    id: `event-${sequence}`,
    aggregateId: "conversation-1",
    conversationId: "conversation-1",
    runId: "run-1",
    sequence,
    timestamp: sequence,
    source: "test",
    type,
    schemaVersion: 1,
    payload,
  };
}

describe("event projector", () => {
  test("projects provider, orchestration, usage, approval, audit, and final events", () => {
    const projector = new EventProjector([conversation()]);
    projector.apply(event(1, "provider.activity", { activity: { id: "activity", kind: "files", label: "Changed a file", status: "completed", createdAt: 2 } }));
    projector.apply(event(2, "orchestration.updated", { event: { operationId: "spawn", tool: "spawn_agent", senderThreadId: "lead", receiverThreads: [{ threadId: "agent-1", name: "Builder", status: "working" }], prompt: "Implement it", status: "running" } }));
    projector.apply(event(3, "usage.updated", { usage: { inputTokens: 20, outputTokens: 10, costUsd: 0.02 } }));
    const approval = projector.apply(event(4, "approval.requested", { approval: { id: "approval-1", deviceId: "local", deviceName: "Mac", conversationId: "conversation-1", capability: "commands", action: "run command", target: "npm test", createdAt: 4 } }));
    const audit = projector.apply(event(5, "audit.recorded", { audit: { id: "audit-1", deviceId: "local", conversationId: "conversation-1", provider: "codex", capability: "commands", action: "run_command", target: "npm test", decision: "allowed", status: "completed", createdAt: 5 } }));
    projector.apply(event(6, "run.final", { message: { id: "answer", role: "assistant", content: "Done", createdAt: 6, provider: "codex" } }));

    expect(projector.conversation("conversation-1")).toMatchObject({
      activities: [{ id: "activity", status: "completed" }],
      agentRuns: [{ threadId: "agent-1", name: "Builder", status: "working" }],
      usage: { inputTokens: 20, outputTokens: 10, costUsd: 0.02 },
      messages: [{ id: "answer", content: "Done" }],
    });
    expect(approval).toMatchObject({ kind: "approval", approval: { id: "approval-1" } });
    expect(audit).toMatchObject({ kind: "audit", audit: { id: "audit-1" } });
  });
});
