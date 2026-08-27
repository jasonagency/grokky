import { createHash, randomUUID } from "node:crypto";
import type { ControlPlaneDatabase } from "../storage/database-types";
import type { EvalCase, EvalComparisonResult, EvalMetricSet, EvalRun, EvalStateSnapshot, EvalVerificationRule, TraceBundle } from "../../shared/control-plane-contracts";
import { hashTrace } from "./trace-service";
import { gradeDeterministic } from "./eval-graders";

const EMPTY: EvalStateSnapshot = { revision: 0, cases: [], runs: [] };
const SECRET_KEY = /(?:api[_-]?key|authorization|token|password|secret|cookie)/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "string") {
    return value.replace(/(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|or|ghp|github_pat)_[A-Za-z0-9_-]{8,})/gi, (secret) => `[redacted:${createHash("sha256").update(secret).digest("hex").slice(0, 12)}]`);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SECRET_KEY.test(key) ? `[redacted:${createHash("sha256").update(String(item)).digest("hex").slice(0, 12)}]` : redact(item)]));
}

export class EvalService {
  private state: EvalStateSnapshot = structuredClone(EMPTY);
  constructor(private readonly database: Pick<ControlPlaneDatabase, "readQualityState" | "writeQualityState">, private readonly now = Date.now) {}

  async initialize(): Promise<void> {
    const stored = await this.database.readQualityState();
    this.state = stored ? JSON.parse(stored) as EvalStateSnapshot : structuredClone(EMPTY);
  }

  snapshot(): EvalStateSnapshot { return structuredClone(this.state); }

  async promote(input: { id: string; name: string; trace: TraceBundle; expectedOutcome: string; allowedSideEffects?: string[]; verificationRules: EvalVerificationRule[] }): Promise<EvalCase> {
    const prior = this.state.cases.filter((entry) => entry.id === input.id);
    const frozenTrace = redact(input.trace) as TraceBundle;
    const entry: EvalCase = {
      id: input.id,
      version: Math.max(0, ...prior.map((item) => item.version)) + 1,
      name: input.name,
      sourceTraceHash: hashTrace(frozenTrace),
      frozenTrace,
      expectedOutcome: input.expectedOutcome,
      allowedSideEffects: [...(input.allowedSideEffects ?? [])],
      verificationRules: structuredClone(input.verificationRules),
      createdAt: this.now(),
    };
    this.state.cases.push(entry);
    await this.persist();
    return structuredClone(entry);
  }

  async grade(caseId: string, version: number, trace: TraceBundle, metrics: EvalMetricSet): Promise<EvalRun> {
    const entry = this.state.cases.find((item) => item.id === caseId && item.version === version);
    if (!entry) throw new Error("Evaluation case was not found");
    const graders = gradeDeterministic(entry, trace, metrics);
    const run: EvalRun = { id: `eval:${randomUUID()}`, caseId, caseVersion: version, traceHash: hashTrace(trace), metrics: structuredClone(metrics), graders, passed: graders.every((grader) => grader.passed), createdAt: this.now() };
    this.state.runs.push(run);
    await this.persist();
    return structuredClone(run);
  }

  compare(baselineId: string, candidateId: string): EvalComparisonResult {
    const baseline = this.state.runs.find((run) => run.id === baselineId);
    const candidate = this.state.runs.find((run) => run.id === candidateId);
    if (!baseline || !candidate) throw new Error("Evaluation run was not found");
    const delta = {
      costUsd: candidate.metrics.costUsd - baseline.metrics.costUsd,
      latencyMs: candidate.metrics.latencyMs - baseline.metrics.latencyMs,
      toolCount: candidate.metrics.toolCount - baseline.metrics.toolCount,
      policyViolations: candidate.metrics.policyViolations - baseline.metrics.policyViolations,
      ...(baseline.metrics.diffSize !== undefined && candidate.metrics.diffSize !== undefined ? { diffSize: candidate.metrics.diffSize - baseline.metrics.diffSize } : {}),
    };
    return { baseline: structuredClone(baseline), candidate: structuredClone(candidate), delta, deterministicRegression: baseline.passed && !candidate.passed };
  }

  private async persist(): Promise<void> {
    this.state.revision += 1;
    await this.database.writeQualityState(JSON.stringify(this.state));
  }
}
