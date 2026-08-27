import { randomUUID } from "node:crypto";
import type { ReplayRequest, ReplayResult, TraceRecord } from "../../shared/control-plane-contracts";

export interface ForkReplayExecutor {
  execute(request: ReplayRequest): Promise<TraceRecord[]>;
}

function recordedToolResult(record: TraceRecord): { tool: string; result: unknown } | undefined {
  const payload = record.event.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const value = payload as Record<string, unknown>;
  const tool = record.links.tool;
  if (!tool || !("result" in value || "output" in value)) return undefined;
  return { tool, result: value.result ?? value.output };
}

export class ReplayService {
  constructor(private readonly executor?: ForkReplayExecutor) {}

  async replay(request: ReplayRequest): Promise<ReplayResult> {
    const events = request.trace.events.filter((record) => record.ordinal >= (request.fromOrdinal ?? 0));
    if (request.mode === "inspection") return { mode: "inspection", executed: false, events: structuredClone(events), substitutions: [] };
    if (request.mode === "simulated") {
      const substitutions = events.flatMap((record) => {
        const found = recordedToolResult(record);
        return found ? [{ ordinal: record.ordinal, tool: found.tool, result: structuredClone(found.result), substituted: true as const }] : [];
      });
      return { mode: "simulated", executed: false, events: structuredClone(events), substitutions };
    }
    if (!request.disposableLease?.disposable) throw new Error("Forked replay requires a disposable workspace lease");
    if (!request.approvalGranted) throw new Error("Forked replay requires current operator approval");
    if (request.budgetRemainingUsd === undefined || request.budgetRemainingUsd <= 0) throw new Error("Forked replay requires remaining budget");
    if (!this.executor) throw new Error("Forked replay executor is not available");
    return { mode: "forked", executed: true, events: await this.executor.execute(request), substitutions: [], forkId: `replay:${randomUUID()}` };
  }
}
