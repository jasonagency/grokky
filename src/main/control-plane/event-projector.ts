import type {
  ArtifactEventPayload,
  ControlPlaneEvent,
  ProjectionChange,
} from "../../shared/control-plane-contracts";
import type {
  ActivityItem,
  AgentIcon,
  AgentRunStatus,
  ChatMessage,
  ComputerApprovalRequest,
  ComputerAuditEntry,
  Conversation,
  OrchestrationEvent,
  UsageSummary,
} from "../../shared/contracts";
import { communicationsFromOrchestrationEvent, mergeCrewCommunications } from "../crew-communications";

function objectPayload(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function artifactPayload(value: unknown): ArtifactEventPayload | undefined {
  const payload = objectPayload(value);
  const artifact = objectPayload(payload?.artifact);
  if (!payload || !artifact || typeof artifact.sha256 !== "string" || typeof payload.preview !== "string") return undefined;
  return payload as unknown as ArtifactEventPayload;
}

function stateStatus(value: string): AgentRunStatus {
  if (/complete|done/i.test(value)) return "completed";
  if (/fail|error|not_found/i.test(value)) return "failed";
  if (/stop|shutdown|close|interrupt/i.test(value)) return "stopped";
  if (/wait/i.test(value)) return "waiting";
  if (/pending|init|start/i.test(value)) return "starting";
  return "working";
}

function applyOrchestration(conversation: Conversation, event: OrchestrationEvent, timestamp: number, icons: Record<string, AgentIcon> = {}): void {
  if (event.tool === "spawn_agent" && event.status === "running" && !event.receiverThreads.length) {
    const pendingId = `pending:${event.operationId}`;
    if (!conversation.agentRuns.some((run) => run.id === pendingId)) {
      conversation.agentRuns.push({
        id: pendingId,
        operationId: event.operationId,
        threadId: pendingId,
        name: "Starting agent",
        task: event.prompt || "Preparing delegated work",
        status: "starting",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  } else {
    if (event.tool === "spawn_agent" && event.receiverThreads.length) {
      conversation.agentRuns = conversation.agentRuns.filter((run) => run.id !== `pending:${event.operationId}`);
    }
    for (const thread of event.receiverThreads) {
      const icon = thread.name ? icons[thread.name.toLowerCase()] : undefined;
      const index = conversation.agentRuns.findIndex((run) => run.threadId === thread.threadId);
      const status = event.tool === "wait" && event.status === "running" ? "waiting" : stateStatus(thread.status);
      if (index >= 0) {
        const previous = conversation.agentRuns[index]!;
        conversation.agentRuns[index] = {
          ...previous,
          status,
          ...(thread.name ? { name: thread.name } : {}),
          ...(icon ? { icon } : {}),
          ...(event.prompt && event.tool !== "wait" ? { task: event.prompt } : {}),
          ...(thread.message ? { result: thread.message } : {}),
          ...(thread.runtime ? { runtime: thread.runtime } : {}),
          updatedAt: timestamp,
        };
      } else {
        conversation.agentRuns.push({
          id: thread.threadId,
          operationId: event.operationId,
          threadId: thread.threadId,
          name: thread.name || `Crew member ${conversation.agentRuns.length + 1}`,
          ...(icon ? { icon } : {}),
          task: event.prompt || "Delegated task",
          status,
          ...(thread.message ? { result: thread.message } : {}),
          ...(thread.runtime ? { runtime: thread.runtime } : {}),
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    }
  }
  conversation.agentRuns = conversation.agentRuns.slice(-40);
  conversation.crewCommunications = mergeCrewCommunications(
    conversation.crewCommunications,
    communicationsFromOrchestrationEvent(event, conversation.agentRuns, timestamp),
  );
}

export function boundedConversationProjection(conversation: Conversation): Conversation {
  const bounded: Conversation = {
    ...structuredClone(conversation),
    messages: conversation.messages.slice(-200).map((message) => ({ ...message, content: message.content.slice(0, 32_000) })),
    activities: conversation.activities.slice(-80).map((activity) => ({ ...activity, ...(activity.detail ? { detail: activity.detail.slice(0, 12_000) } : {}) })),
    agentRuns: conversation.agentRuns.slice(-40).map((run) => ({ ...run, ...(run.result ? { result: run.result.slice(0, 12_000) } : {}) })),
    crewCommunications: conversation.crewCommunications.slice(-80).map((entry) => ({ ...entry, ...(entry.content ? { content: entry.content.slice(0, 12_000) } : {}) })),
    harnessAttempts: conversation.harnessAttempts?.slice(-40),
  };
  while (bounded.messages.length > 1 && Buffer.byteLength(JSON.stringify(bounded), "utf8") > 220 * 1024) bounded.messages.shift();
  while (bounded.activities.length > 1 && Buffer.byteLength(JSON.stringify(bounded), "utf8") > 220 * 1024) bounded.activities.shift();
  while (bounded.crewCommunications.length > 1 && Buffer.byteLength(JSON.stringify(bounded), "utf8") > 220 * 1024) bounded.crewCommunications.shift();
  return bounded;
}

export class EventProjector {
  private readonly conversations = new Map<string, Conversation>();

  constructor(conversations: Conversation[] = []) {
    for (const conversation of conversations) this.conversations.set(conversation.id, boundedConversationProjection(conversation));
  }

  fork(): EventProjector {
    return new EventProjector([...this.conversations.values()]);
  }

  conversation(id: string): Conversation | undefined {
    const conversation = this.conversations.get(id);
    return conversation ? structuredClone(conversation) : undefined;
  }

  allConversations(): Conversation[] {
    return [...this.conversations.values()].map((conversation) => structuredClone(conversation));
  }

  apply(event: ControlPlaneEvent): ProjectionChange {
    const payload = objectPayload(event.payload);
    if (event.type === "conversation.snapshot") {
      const conversation = payload?.conversation as Conversation | undefined;
      if (conversation && conversation.id === event.conversationId) {
        const bounded = boundedConversationProjection(conversation);
        this.conversations.set(conversation.id, bounded);
        return this.conversationChange(event, bounded);
      }
      return this.none(event);
    }

    if (event.type === "approval.requested") {
      const approval = payload?.approval as ComputerApprovalRequest | undefined;
      return approval ? { eventId: event.id, aggregateId: event.aggregateId, sequence: event.sequence, kind: "approval", approval: structuredClone(approval) } : this.none(event);
    }
    if (event.type === "audit.recorded") {
      const audit = payload?.audit as ComputerAuditEntry | undefined;
      return audit ? { eventId: event.id, aggregateId: event.aggregateId, sequence: event.sequence, kind: "audit", audit: structuredClone(audit) } : this.none(event);
    }

    const conversationId = event.conversationId;
    const conversation = conversationId ? this.conversations.get(conversationId) : undefined;
    if (!conversation) return this.none(event);

    if (event.type === "run.started") conversation.status = "running";
    if (event.type === "provider.thread" && typeof payload?.threadId === "string") conversation.threadId = payload.threadId;
    if (event.type === "provider.activity") {
      const activity = payload?.activity as ActivityItem | undefined;
      if (activity?.id) {
        const index = conversation.activities.findIndex((item) => item.id === activity.id);
        if (index >= 0) conversation.activities[index] = { ...activity, createdAt: conversation.activities[index]!.createdAt };
        else conversation.activities.push(structuredClone(activity));
        conversation.activities = conversation.activities.slice(-80);
      }
    }
    if (event.type === "orchestration.updated") {
      const orchestration = payload?.event as OrchestrationEvent | undefined;
      const icons = payload?.icons && typeof payload.icons === "object" ? payload.icons as Record<string, AgentIcon> : {};
      if (orchestration?.operationId) applyOrchestration(conversation, orchestration, event.timestamp, icons);
    }
    if (event.type === "usage.updated") {
      const usage = payload?.usage as UsageSummary | undefined;
      if (usage && typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number") conversation.usage = structuredClone(usage);
    }
    if (event.type === "run.final") {
      const message = payload?.message as ChatMessage | undefined;
      if (message?.id) conversation.messages.push(structuredClone(message));
      else {
        const artifact = artifactPayload(event.payload);
        if (artifact) conversation.messages.push({
          id: `${event.id}:artifact`,
          role: "assistant",
          content: artifact.preview,
          createdAt: event.timestamp,
          provider: conversation.provider,
        });
      }
      conversation.messages = conversation.messages.slice(-200);
    }
    if (event.type === "run.completed") {
      conversation.status = "idle";
      const outcome = payload?.outcome;
      if (outcome === "delivered" || outcome === "blocked") conversation.lastRunOutcome = outcome;
    }
    if (event.type === "run.failed") {
      conversation.status = "error";
      conversation.lastRunOutcome = "failed";
      if (typeof payload?.error === "string") conversation.error = payload.error.slice(0, 2_000);
    }
    if (event.type === "run.stopped") {
      conversation.status = "idle";
      conversation.lastRunOutcome = "stopped";
    }
    conversation.updatedAt = event.timestamp;
    return this.conversationChange(event, conversation);
  }

  private conversationChange(event: ControlPlaneEvent, conversation: Conversation): ProjectionChange {
    const bounded = boundedConversationProjection(conversation);
    this.conversations.set(conversation.id, bounded);
    return { eventId: event.id, aggregateId: event.aggregateId, sequence: event.sequence, kind: "conversation", conversation: structuredClone(bounded) };
  }

  private none(event: ControlPlaneEvent): ProjectionChange {
    return { eventId: event.id, aggregateId: event.aggregateId, sequence: event.sequence, kind: "none" };
  }
}
