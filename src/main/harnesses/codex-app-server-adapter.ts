import { randomUUID } from "node:crypto";
import { CODEX_MODELS } from "../../shared/contracts";
import type { ActivityItem } from "../../shared/contracts";
import type { HarnessAdapter } from "./types";
import type { HarnessControl, HarnessControlResult } from "../../shared/harness-contracts";
import type { ProviderRunContext } from "../providers/types";
import { codexCredentialStatus } from "../credentials";
import { crewPrompt } from "../providers/codex-provider";
import { CodexAppServerClient } from "./codex-app-server-client";
import { CodexAppServerProcess, resolveCodexExecutable } from "./codex-app-server-process";
import { CodexSdkAdapter } from "./codex-sdk-adapter";

interface AppServerClient {
  initialize(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  onNotification(listener: (method: string, params: unknown) => void | Promise<void>): () => void;
  onRequest(listener: (method: string, params: unknown) => unknown | Promise<unknown>): void;
  onFatal(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export type CodexAppServerClientFactory = () => Promise<AppServerClient>;

interface ActiveTurn {
  client: AppServerClient;
  sessionId: string;
  turnId: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function textInput(text: string) {
  return [{ type: "text", text, text_elements: [] }];
}

function itemActivity(itemValue: unknown, status: ActivityItem["status"]): ActivityItem | undefined {
  const item = record(itemValue);
  const id = string(item?.id);
  const type = string(item?.type);
  if (!id || !type || type === "agentMessage" || type === "userMessage") return undefined;
  const createdAt = Date.now();
  if (type === "reasoning") return { id, kind: "reasoning", label: "Reasoning", detail: Array.isArray(item?.summary) ? item.summary.join("\n") : undefined, status, createdAt };
  if (type === "commandExecution") return { id, kind: "command", label: "Command execution", detail: string(item?.aggregatedOutput)?.slice(-12_000), status, createdAt };
  if (type === "fileChange") return { id, kind: "files", label: "File changes", detail: Array.isArray(item?.changes) ? `${item.changes.length} change(s)` : undefined, status, createdAt };
  if (type === "mcpToolCall") return { id, kind: "tool", label: `${string(item?.server) || "MCP"}.${string(item?.tool) || "tool"}`, status, createdAt };
  if (type === "plan") return { id, kind: "plan", label: "Plan updated", detail: string(item?.text), status, createdAt };
  if (type === "collabAgentToolCall") return { id, kind: "agent", label: `Agent ${string(item?.tool) || "coordination"}`, status, createdAt };
  return { id, kind: "notice", label: type, status, createdAt };
}

function threadIdFromResponse(value: unknown): string {
  const thread = record(record(value)?.thread);
  const id = string(thread?.id);
  if (!id) throw new Error("Codex App Server returned an invalid thread response");
  return id;
}

function turnIdFromResponse(value: unknown): string {
  const turn = record(record(value)?.turn);
  const id = string(turn?.id);
  if (!id) throw new Error("Codex App Server returned an invalid turn response");
  return id;
}

export class CodexAppServerAdapter implements HarnessAdapter {
  readonly descriptor = {
    id: "codex-app-server",
    version: "0.149-protocol-1",
    displayName: "Codex App Server",
    providerCompatibility: ["codex" as const],
    compatibilityPriority: 100,
    models: CODEX_MODELS.map((id) => ({ id, label: id })),
    capabilities: {
      sessionPersistence: true,
      streaming: true,
      steering: "mid-turn" as const,
      cancellation: true,
      tools: true,
      mcp: true,
      usage: "authoritative" as const,
      computerControl: true,
      multiAgent: true,
    },
  };

  private readonly active = new Map<string, ActiveTurn>();
  private readonly clients = new Set<AppServerClient>();

  constructor(
    private readonly clientFactory: CodexAppServerClientFactory = async () => {
      const client = new CodexAppServerClient(CodexAppServerProcess.launch({ resourcesPath: process.resourcesPath }));
      await client.initialize();
      return client;
    },
    private readonly fallback: HarnessAdapter = new CodexSdkAdapter(),
  ) {}

  async health({ homeDirectory }: Parameters<HarnessAdapter["health"]>[0]) {
    const credential = await codexCredentialStatus(homeDirectory);
    try {
      resolveCodexExecutable({ resourcesPath: process.resourcesPath });
      const { id: _provider, ...health } = credential;
      return { ...health, source: `${health.source} + App Server` };
    } catch (error) {
      return { ready: false, label: "Codex runtime missing", source: "Bundled App Server", detail: error instanceof Error ? error.message : "Unable to locate Codex" };
    }
  }

  async run(context: ProviderRunContext): Promise<void> {
    let client: AppServerClient;
    try {
      client = await this.clientFactory();
    } catch (error) {
      await context.onEvent({ type: "activity", activity: { id: randomUUID(), kind: "notice", label: "Codex SDK fallback selected", detail: error instanceof Error ? error.message : "App Server startup failed", status: "completed", createdAt: Date.now() } });
      await this.fallback.run(context);
      return;
    }
    this.clients.add(client);
    let turnStarted = false;
    let completed = false;
    let finalEmitted = false;
    let pendingFinalText: string | undefined;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
    let sessionId = context.conversation.threadId;
    let activeTurn: ActiveTurn | undefined;
    const earlyCompletions = new Map<string, Record<string, unknown>>();
    const finishTurn = (turn: Record<string, unknown>) => {
      if (completed) return;
      completed = true;
      const status = string(turn.status);
      if (status === "failed") rejectCompletion(new Error(string(record(turn.error)?.message) || "Codex turn failed"));
      else resolveCompletion();
    };

    client.onRequest(async (method, params) => {
      const info = record(params);
      const isFile = method === "item/fileChange/requestApproval" || method === "applyPatchApproval";
      const label = isFile ? "File change approval requested" : "Command approval requested";
      await context.onEvent({ type: "activity", activity: {
        id: string(info?.itemId) || randomUUID(), kind: "notice", label,
        detail: string(info?.reason) || "Codex requested permission; sensitive command arguments were redacted.",
        status: context.conversation.sandboxMode === "workspace-write" ? "completed" : "failed", createdAt: Date.now(),
      } });
      const allowed = context.conversation.sandboxMode === "workspace-write" && (isFile || context.conversation.allowCommands);
      const legacy = method === "applyPatchApproval" || method === "execCommandApproval";
      return { decision: legacy ? (allowed ? "approved" : { denied: { rejection: "Denied by PuckBot policy" } }) : (allowed ? "accept" : "decline") };
    });

    const unsubscribeNotification = client.onNotification(async (method, paramsValue) => {
      const params = record(paramsValue);
      if (method === "item/started" || method === "item/completed") {
        const activity = itemActivity(params?.item, method === "item/completed" ? "completed" : "running");
        if (activity) await context.onEvent({ type: "activity", activity });
        const item = record(params?.item);
        if (method === "item/completed" && item?.type === "agentMessage" && string(item.text)) {
          pendingFinalText = string(item.text);
        }
      } else if (method === "thread/tokenUsage/updated") {
        const last = record(record(params?.tokenUsage)?.last);
        if (last) await context.onEvent({ type: "usage", usage: {
          inputTokens: typeof last.inputTokens === "number" ? last.inputTokens : 0,
          cachedInputTokens: typeof last.cachedInputTokens === "number" ? last.cachedInputTokens : 0,
          outputTokens: typeof last.outputTokens === "number" ? last.outputTokens : 0,
          reasoningTokens: typeof last.reasoningOutputTokens === "number" ? last.reasoningOutputTokens : 0,
        } });
      } else if (method === "turn/completed") {
        const turn = record(params?.turn);
        const completedTurnId = string(turn?.id);
        if (!turn || !completedTurnId) return;
        if (!activeTurn) earlyCompletions.set(completedTurnId, turn);
        else if (completedTurnId === activeTurn.turnId) {
          if (pendingFinalText && !finalEmitted) {
            finalEmitted = true;
            await context.onEvent({ type: "final", text: pendingFinalText });
          }
          finishTurn(turn);
        }
      } else if (method === "error" && !record(paramsValue)?.willRetry) {
        rejectCompletion(new Error(string(record(record(paramsValue)?.error)?.message) || "Codex App Server turn error"));
      }
    });
    const unsubscribeFatal = client.onFatal((error) => rejectCompletion(error));

    const onAbort = () => {
      if (activeTurn) void client.request("turn/interrupt", { threadId: activeTurn.sessionId, turnId: activeTurn.turnId }).catch(() => undefined);
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (sessionId) {
        const response = await client.request("thread/resume", {
          threadId: sessionId, cwd: context.conversation.workingDirectory,
          runtimeWorkspaceRoots: [context.conversation.workingDirectory],
          approvalPolicy: "on-request", sandbox: context.conversation.sandboxMode,
        });
        sessionId = threadIdFromResponse(response);
      } else {
        const response = await client.request("thread/start", {
          model: context.conversation.model, cwd: context.conversation.workingDirectory,
          runtimeWorkspaceRoots: [context.conversation.workingDirectory],
          approvalPolicy: "on-request", sandbox: context.conversation.sandboxMode,
          config: { features: { apps: context.settings.connectorsEnabled, browser_use: context.settings.webSearchEnabled, multi_agent: context.settings.multiAgentEnabled } },
        });
        sessionId = threadIdFromResponse(response);
      }
      await context.onEvent({ type: "thread", threadId: sessionId });
      if (context.signal.aborted) throw new Error("Codex turn was cancelled before start");
      const response = await client.request("turn/start", {
        threadId: sessionId,
        input: textInput(crewPrompt(context.prompt, context.agents, context.settings.webSearchEnabled, context.conversation.allowCommands)),
        cwd: context.conversation.workingDirectory,
        runtimeWorkspaceRoots: [context.conversation.workingDirectory],
        approvalPolicy: "on-request",
        model: context.conversation.model,
        effort: context.conversation.reasoning,
      });
      activeTurn = { client, sessionId, turnId: turnIdFromResponse(response) };
      this.active.set(sessionId, activeTurn);
      turnStarted = true;
      const earlyCompletion = earlyCompletions.get(activeTurn.turnId);
      if (earlyCompletion) {
        if (pendingFinalText && !finalEmitted) {
          finalEmitted = true;
          await context.onEvent({ type: "final", text: pendingFinalText });
        }
        finishTurn(earlyCompletion);
      }
      await completion;
      if (!finalEmitted && !context.signal.aborted) await context.onEvent({ type: "final", text: "Codex completed without a final text response." });
    } catch (error) {
      if (!turnStarted) {
        await context.onEvent({ type: "activity", activity: { id: randomUUID(), kind: "notice", label: "Codex SDK fallback selected", detail: error instanceof Error ? error.message : "App Server session failed", status: "completed", createdAt: Date.now() } });
        await this.fallback.run(context);
        return;
      }
      throw error;
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      unsubscribeNotification();
      unsubscribeFatal();
      if (sessionId) this.active.delete(sessionId);
      this.clients.delete(client);
      await client.close();
    }
  }

  async deliverControl(control: HarnessControl): Promise<HarnessControlResult> {
    const matches = control.sessionId ? [this.active.get(control.sessionId)].filter(Boolean) as ActiveTurn[] : [...this.active.values()];
    if (matches.length !== 1) return { accepted: false, reason: matches.length ? "Multiple Codex turns are active; select a session" : "No Codex App Server turn is active" };
    const active = matches[0]!;
    if (control.type === "steer" && control.turnId && control.turnId !== active.turnId) return { accepted: false, reason: `Stale turn id ${control.turnId}` };
    if (control.type === "cancel" && control.turnId && control.turnId !== active.turnId) return { accepted: false, reason: `Stale turn id ${control.turnId}` };
    try {
      if (control.type === "cancel") await active.client.request("turn/interrupt", { threadId: active.sessionId, turnId: active.turnId });
      else if (control.type === "steer") await active.client.request("turn/steer", { threadId: active.sessionId, expectedTurnId: active.turnId, input: textInput(control.message) });
      else await active.client.request("thread/queue/add", { threadId: active.sessionId, clientUserMessageId: randomUUID(), input: textInput(control.message) });
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Codex control delivery failed" };
    }
  }

  async cleanup(): Promise<void> {
    await Promise.all([...this.clients].map((client) => client.close()));
    this.clients.clear();
    this.active.clear();
    await this.fallback.cleanup();
  }
}
