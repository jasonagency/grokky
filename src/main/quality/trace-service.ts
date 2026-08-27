import { createHash } from "node:crypto";
import type { ControlPlaneEvent, TraceBundle, TraceQuery, TraceRecord } from "../../shared/control-plane-contracts";
import type { ControlPlaneService } from "../control-plane/control-plane-service";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function links(event: ControlPlaneEvent): TraceRecord["links"] {
  const payload = object(event.payload);
  const nested = object(payload.activity ?? payload.command ?? payload.audit ?? payload.decision ?? payload);
  const artifact = object(payload.artifact);
  return {
    ...text(payload.goalId) && { goalId: text(payload.goalId) },
    ...(event.runId && { runId: event.runId }),
    ...(event.taskId && { taskId: event.taskId }),
    ...(event.attemptId && { attemptId: event.attemptId }),
    ...text(payload.agentId ?? nested.agentId) && { agentId: text(payload.agentId ?? nested.agentId) },
    ...text(payload.harnessId ?? nested.harnessId) && { harnessId: text(payload.harnessId ?? nested.harnessId) },
    ...text(payload.tool ?? nested.tool ?? nested.name) && { tool: text(payload.tool ?? nested.tool ?? nested.name) },
    ...text(artifact.sha256) && { artifactSha256: text(artifact.sha256) },
  };
}

function matches(record: TraceRecord, query: TraceQuery): boolean {
  const event = record.event;
  const content = JSON.stringify(event.payload);
  return (!query.goalId || record.links.goalId === query.goalId)
    && (!query.runId || event.runId === query.runId)
    && (!query.taskId || event.taskId === query.taskId)
    && (!query.attemptId || event.attemptId === query.attemptId)
    && (!query.agentId || record.links.agentId === query.agentId)
    && (!query.harnessId || record.links.harnessId === query.harnessId)
    && (!query.tool || record.links.tool === query.tool)
    && (!query.policyDecision || content.includes(query.policyDecision))
    && (!query.artifactSha256 || record.links.artifactSha256 === query.artifactSha256)
    && (query.from === undefined || event.timestamp >= query.from)
    && (query.to === undefined || event.timestamp <= query.to);
}

export function hashTrace(trace: TraceBundle): string {
  return createHash("sha256").update(JSON.stringify(trace.events.map(({ event }) => event))).digest("hex");
}

export class TraceService {
  constructor(private readonly controlPlane: Pick<ControlPlaneService, "events" | "deleteExpiredArtifacts">, private readonly now = Date.now) {}

  async query(query: TraceQuery = {}): Promise<TraceBundle> {
    const events = (await this.controlPlane.events())
      .sort((left, right) => left.timestamp - right.timestamp || left.aggregateId.localeCompare(right.aggregateId) || left.sequence - right.sequence);
    const records = events.map((event, ordinal) => ({ event, ordinal, links: links(event) }));
    return { query: structuredClone(query), events: records.filter((record) => matches(record, query)), generatedAt: this.now() };
  }

  applyRetention(): Promise<number> { return this.controlPlane.deleteExpiredArtifacts(this.now()); }
}
