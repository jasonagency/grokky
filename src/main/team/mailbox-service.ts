import { randomUUID } from "node:crypto";
import type { AgentMailboxMessage } from "../../shared/contracts";
import type { TeamRepository } from "./agent-runtime-service";

export class MailboxService {
  constructor(private readonly repository: TeamRepository, private readonly now = Date.now) {}

  async send(input: Omit<AgentMailboxMessage, "id" | "acknowledgedBy" | "createdAt">): Promise<AgentMailboxMessage> {
    if (!input.receiverIds.length) throw new Error("Mailbox message requires a receiver");
    const message: AgentMailboxMessage = { ...structuredClone(input), id: `mail:${randomUUID()}`, acknowledgedBy: [], createdAt: this.now() };
    await this.repository.mutate((state) => { state.messages.push(message); });
    return structuredClone(message);
  }

  list(agentId: string, afterId?: string): AgentMailboxMessage[] {
    const all = this.repository.snapshot().messages.filter((message) => message.senderId === agentId || message.receiverIds.includes(agentId));
    const cursor = afterId ? all.findIndex((message) => message.id === afterId) : -1;
    return all.slice(cursor + 1);
  }

  async acknowledge(messageId: string, agentId: string): Promise<AgentMailboxMessage> {
    let result!: AgentMailboxMessage;
    await this.repository.mutate((state) => {
      const message = state.messages.find((item) => item.id === messageId);
      if (!message || !message.receiverIds.includes(agentId)) throw new Error("Mailbox message was not found for this agent");
      if (!message.acknowledgedBy.includes(agentId)) message.acknowledgedBy.push(agentId);
      if (message.handoff?.toAgentId === agentId && !message.handoff.acceptedAt) message.handoff.acceptedAt = this.now();
      result = structuredClone(message);
    });
    return result;
  }
}
