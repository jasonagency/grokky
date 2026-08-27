import { describe, expect, test } from "vitest";
import { TeamRepository } from "../src/main/team/agent-runtime-service";
import { MailboxService } from "../src/main/team/mailbox-service";
import { teamStore } from "./support/team-store";

describe("MailboxService", () => {
  test("persists a direct handoff with ownership metadata and receiving acknowledgement", async () => {
    const store = teamStore();
    const repository = new TeamRepository(store.database);
    await repository.initialize();
    const mailbox = new MailboxService(repository, () => 42);
    const message = await mailbox.send({ threadId: "task:one", senderId: "agent:a", receiverIds: ["agent:b"], taskId: "task", kind: "handoff", content: "Take over verification", handoff: { fromAgentId: "agent:a", toAgentId: "agent:b" } });
    const acknowledged = await mailbox.acknowledge(message.id, "agent:b");
    expect(acknowledged).toMatchObject({ acknowledgedBy: ["agent:b"], handoff: { fromAgentId: "agent:a", toAgentId: "agent:b", acceptedAt: 42 } });
    expect(mailbox.list("agent:b")).toEqual([acknowledged]);
  });
});
