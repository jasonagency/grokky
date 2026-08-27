import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_PI_MODEL } from "../../shared/contracts";
import type { HarnessControl, HarnessControlResult } from "../../shared/harness-contracts";
import { piCredentialStatus, resolveOpenRouterCredential } from "../credentials";
import type { ProviderRunContext } from "../providers/types";
import { PiEventMapper } from "./pi-events";
import { createPiResourceLoader } from "./pi-resources";
import { createPiTools } from "./pi-tools";
import type { HarnessAdapter } from "./types";

export interface PiSessionLike {
  sessionId: string;
  sessionFile?: string;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  getLastAssistantText(): string | undefined;
  getSessionStats(): { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost: number };
}

export type PiSessionFactory = (context: ProviderRunContext, existingSession?: string) => Promise<PiSessionLike>;

function splitModel(value: string): { provider: string; modelId: string } {
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1) throw new Error("Pi models must use provider/model format");
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function safeSessionPath(pathname: string, sessionRoot: string): string {
  const candidate = resolve(pathname);
  const root = resolve(sessionRoot);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new Error("Pi session reference is outside Grokky session storage");
  return candidate;
}

export function defaultPiSessionFactory(homeDirectory: string, sessionRoot = join(homeDirectory, ".grokky", "pi-sessions")): PiSessionFactory {
  return async (context, existingSession) => {
    const cwd = context.conversation.workingDirectory;
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homeDirectory, ".pi", "agent");
    const sessionDirectory = join(sessionRoot, createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 24));
    await mkdir(sessionDirectory, { recursive: true });
    const requested = context.conversation.model === DEFAULT_PI_MODEL ? undefined : splitModel(context.conversation.model);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
    });
    if (requested?.provider === "openrouter") {
      const credential = await resolveOpenRouterCredential(context.settings, homeDirectory);
      if (credential) await modelRuntime.setRuntimeApiKey("openrouter", credential.apiKey);
    }
    let model = requested ? modelRuntime.getModel(requested.provider, requested.modelId) : (await modelRuntime.getAvailable())[0];
    if (!model && requested?.provider === "openrouter" && modelRuntime.hasConfiguredAuth(requested.provider)) {
      await modelRuntime.refresh().catch(() => undefined);
      model = modelRuntime.getModel(requested.provider, requested.modelId);
    }
    if (!model) throw new Error(`Pi model ${context.conversation.model} is unavailable or not configured`);
    const resourceLoader = await createPiResourceLoader({ cwd, agentDir, selectedSkillPaths: context.selectedSkillPaths });
    const customTools = createPiTools(context);
    const sessionManager = existingSession
      ? SessionManager.open(safeSessionPath(existingSession, sessionRoot), sessionDirectory, cwd)
      : SessionManager.create(cwd, sessionDirectory);
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: context.conversation.reasoning,
      resourceLoader,
      sessionManager,
      noTools: "all",
      tools: customTools.map((tool) => tool.name),
      customTools,
    });
    return session as AgentSession;
  };
}

interface ActivePiSession {
  reference: string;
  session: PiSessionLike;
}

export class PiAdapter implements HarnessAdapter {
  readonly descriptor = {
    id: "pi-native",
    version: "0.83-sdk-1",
    displayName: "Pi native SDK",
    providerCompatibility: ["pi" as const],
    models: [
      { id: DEFAULT_PI_MODEL, label: "Automatic available model" },
      { id: "openai/gpt-5.2", label: "GPT-5.2" },
      { id: "openrouter/openai/gpt-5.2", label: "GPT-5.2 through OpenRouter", dynamic: true },
    ],
    capabilities: {
      sessionPersistence: true,
      streaming: true,
      steering: "mid-turn" as const,
      cancellation: true,
      tools: true,
      mcp: false,
      usage: "authoritative" as const,
      computerControl: true,
      multiAgent: false,
    },
  };

  private readonly active = new Map<string, ActivePiSession>();

  constructor(
    private readonly homeDirectory: string,
    private readonly sessionFactory: PiSessionFactory = defaultPiSessionFactory(homeDirectory),
  ) {}

  async health() {
    const { id: _provider, ...status } = await piCredentialStatus(this.homeDirectory);
    return status;
  }

  async run(context: ProviderRunContext): Promise<void> {
    const session = await this.sessionFactory(context, context.conversation.threadId);
    const reference = session.sessionFile || session.sessionId;
    if (!reference) throw new Error("Pi did not provide a persistent session reference");
    const active = { reference, session };
    this.active.set(reference, active);
    await context.onEvent({ type: "thread", threadId: reference });
    await context.onEvent({ type: "activity", activity: {
      id: `pi-resources-${session.sessionId}`, kind: "notice", label: "Pi controlled resources active",
      detail: "Built-in tools and extensions are disabled. Grokky-gated tools and project guidance are active.", status: "completed", createdAt: Date.now(),
    } });
    const mapper = new PiEventMapper();
    let eventQueue = Promise.resolve();
    const unsubscribe = session.subscribe((event) => {
      eventQueue = eventQueue.then(async () => {
        for (const mapped of mapper.map(event)) await context.onEvent(mapped);
      });
    });
    const abort = () => { void session.abort(); };
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      if (context.signal.aborted) throw new Error("Pi run was cancelled before start");
      await session.prompt(context.prompt);
      await eventQueue;
      const final = mapper.finalText(session.getLastAssistantText());
      if (!final) throw new Error(`Pi completed without a final text response${mapper.failureDetail() ? `: ${mapper.failureDetail()}` : ""}`);
      await context.onEvent({ type: "final", text: final });
      const stats = session.getSessionStats();
      await context.onEvent({ type: "usage", usage: {
        inputTokens: stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite,
        cachedInputTokens: stats.tokens.cacheRead,
        outputTokens: stats.tokens.output,
        costUsd: stats.cost,
      } });
    } finally {
      context.signal.removeEventListener("abort", abort);
      unsubscribe();
      this.active.delete(reference);
      session.dispose();
    }
  }

  async deliverControl(control: HarnessControl): Promise<HarnessControlResult> {
    const matches = control.sessionId ? [this.active.get(control.sessionId)].filter(Boolean) as ActivePiSession[] : [...this.active.values()];
    if (matches.length !== 1) return { accepted: false, reason: matches.length ? "Multiple Pi sessions are active; select one" : "No Pi session is active" };
    try {
      const session = matches[0]!.session;
      if (control.type === "cancel") await session.abort();
      else if (control.type === "steer") await session.steer(control.message);
      else await session.followUp(control.message);
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Pi control delivery failed" };
    }
  }

  async cleanup(): Promise<void> {
    const sessions = [...this.active.values()];
    this.active.clear();
    await Promise.all(sessions.map((active) => active.session.abort().catch(() => undefined)));
    sessions.forEach((active) => active.session.dispose());
  }
}
