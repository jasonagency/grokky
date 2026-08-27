import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserWindow } from "electron";
import type {
  AgentDefinition,
  AgentDraft,
  AgentIcon,
  AgentRunStatus,
  AppSettings,
  AppSnapshot,
  CapabilitiesSnapshot,
  ChatMessage,
  ComputerAccessLevel,
  ComputerApprovalDecision,
  ComputerApprovalRequest,
  ComputerAuditEntry,
  ComputerCapabilityId,
  Conversation,
  ConversationPatch,
  McpToolClassification,
  ProviderStatus,
  RunOutcome,
  AgentMailboxMessage,
  AgentMemory,
  AgentRoutine,
  UsageSummary,
} from "../shared/contracts";
import { CODEX_MODELS, DEFAULT_OPENROUTER_MODEL, DEFAULT_PI_MODEL, IPC } from "../shared/contracts";
import { requiresDevelopmentCommands, requiresProjectDirectory } from "../shared/run-preflight";
import { CapabilitiesService } from "./capabilities";
import { AgentService } from "./agents";
import { capabilityForTool, ComputerAccessService, newAuditId, targetForTool, type ComputerToolName } from "./computer-access";
import type { ProviderEvent } from "./providers/types";
import type { BudgetDecision, BudgetMeasurements, ControlPlaneEventType, ControlPolicyPatch, EvalMetricSet, EvalVerificationRule, IntegrationRecord, ReplayRequest, RouteDecision, TaskAction, TaskControlRequest, TaskGoalDraft, TaskLeaseClaim, TraceBundle, TraceQuery, WorkspaceLease, WorkspaceLeaseRequest } from "../shared/control-plane-contracts";
import type { HarnessAttempt, HarnessRegistryEntry, RequiredHarnessCapabilities } from "../shared/harness-contracts";
import { ControlPlaneService } from "./control-plane/control-plane-service";
import { LeaseReconciler } from "./control-plane/lease-reconciler";
import { TaskExecutionDetachedError, TaskExecutionPausedError, type TaskScheduler } from "./control-plane/scheduler";
import type { WorkspaceLeaseManager } from "./workspaces/workspace-lease-manager";
import { GitRepository } from "./workspaces/git-repository";
import type { IntegrationQueue, VerificationCommand } from "./workspaces/integration-queue";
import type { SteeringService } from "./control-plane/steering-service";
import type { NotificationService } from "./control-plane/notification-service";
import type { HarnessControl } from "../shared/harness-contracts";
import { PolicyEngine } from "./control-plane/policy-engine";
import { BudgetService } from "./control-plane/budget-service";
import { boundedConversationProjection } from "./control-plane/event-projector";
import { communicationsFromOrchestrationEvent, mergeCrewCommunications } from "./crew-communications";
import { createDefaultHarnessRegistry, HarnessRegistry } from "./harnesses/registry";
import { noProjectDirectory, StateStore, type PersistentState } from "./state-store";
import { McpAuthManager } from "./tools/mcp-auth";
import { McpClientManager } from "./tools/mcp-client-manager";
import { ToolGateway } from "./tools/tool-gateway";
import type { HarnessMcpTool } from "./providers/types";
import type { TraceService } from "./quality/trace-service";
import type { ReplayService } from "./quality/replay-service";
import type { EvalService } from "./quality/eval-service";
import type { AgentRuntimeService } from "./team/agent-runtime-service";
import type { MailboxService } from "./team/mailbox-service";
import type { MemoryService } from "./team/memory-service";
import type { RoutineService } from "./team/routine-service";
import type { UpdateService } from "./update-service";
import type { HostClient } from "./remote/host-client";
import type { RemoteEventFrame, RemoteRoutineRegistration } from "../shared/remote-protocol";
import { validateHarnessEvent } from "./harnesses/types";
import { localBackgroundWork, type LocalBackgroundWork } from "./app-lifecycle";

function id(): string {
  return randomUUID().replaceAll("-", "");
}

function titleFromMessage(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 46 ? `${oneLine.slice(0, 45).trimEnd()}…` : oneLine;
}

async function requireDirectory(pathname: string): Promise<string> {
  const info = await stat(pathname);
  if (!info.isDirectory()) throw new Error("Working directory must be a folder");
  return pathname;
}

export function classifyRunOutcome(conversation: Conversation, selectedAgentCount: number): RunOutcome {
  const confirmedRuns = conversation.agentRuns.filter((run) => !/^(?:pending|queued|unconfirmed):/.test(run.id));
  if (selectedAgentCount > 0 && confirmedRuns.length < selectedAgentCount) return "blocked";
  if (confirmedRuns.some((run) => new Set(["failed", "stopped", "starting", "working", "waiting"]).has(run.status))) return "blocked";

  const productiveActivity = conversation.activities.some((activity) => (
    (activity.kind === "files" || activity.kind === "command") && activity.status === "completed"
  ));
  const lastUserIndex = conversation.messages.findLastIndex((message) => message.role === "user");
  const finalText = conversation.messages.slice(lastUserIndex + 1).find((message) => message.role === "assistant")?.content || "";
  if (!finalText.trim()) return "blocked";
  const blockingLanguage = /\b(?:no (?:files?|implementation|changes?) (?:were |was )?(?:made|changed)|could not|couldn't|cannot|can't|unable to|need(?:ed)? to proceed|requires? (?:a|the|your) (?:project|folder|permission)|not enabled|not available)\b/i;
  if (!productiveActivity && blockingLanguage.test(finalText)) return "blocked";
  return "delivered";
}

export class MainController {
  private state!: PersistentState;
  private statuses: ProviderStatus[] = [];
  private harnesses: HarnessRegistryEntry[] = [];
  private window: BrowserWindow | null = null;
  private readonly runs = new Map<string, AbortController>();
  private readonly runTasks = new Map<string, Promise<void>>();
  private readonly runIds = new Map<string, string>();
  private readonly runAgentIcons = new Map<string, Map<string, AgentIcon>>();
  private readonly pendingApprovals: ComputerApprovalRequest[] = [];
  private readonly approvalResolvers = new Map<string, (decision: ComputerApprovalDecision) => void>();
  private readonly sessionComputerGrants = new Map<string, Set<ComputerCapabilityId>>();
  private routineTimer?: ReturnType<typeof setInterval>;
  private taskDispatchTimer?: ReturnType<typeof setInterval>;
  private remoteScreenTimer?: ReturnType<typeof setInterval>;
  private remoteRefreshPromise?: Promise<void>;
  private taskDispatchPromise?: Promise<void>;
  private readonly taskControllers = new Map<string, AbortController>();
  private readonly taskSessions = new Map<string, string>();
  private readonly pendingTaskPauses = new Map<string, string>();
  private readonly remoteTaskClients = new Map<string, { client: HostClient; jobId: string; leaseEpoch: number; cursor: number }>();
  private readonly routineSyncFailures = new Set<string>();
  private readonly capabilities: CapabilitiesService;
  private readonly agents: AgentService;
  private unsubscribeProjection?: () => void;
  private unsubscribeUpdate?: () => void;
  private initialized = false;

  constructor(
    private readonly store: StateStore,
    private readonly homeDirectory: string,
    private readonly appVersion: string,
    private readonly computerAccess = new ComputerAccessService(),
    private readonly controlPlane?: ControlPlaneService,
    private readonly harnessRegistry: HarnessRegistry = createDefaultHarnessRegistry(homeDirectory),
    private readonly taskScheduler?: TaskScheduler,
    private readonly workspaceLeases?: WorkspaceLeaseManager,
    private readonly integrationQueue?: IntegrationQueue,
    private readonly steering?: SteeringService,
    private readonly notifications?: NotificationService,
    private readonly toolGateway: ToolGateway = new ToolGateway(new McpClientManager(new McpAuthManager())),
    private readonly traces?: TraceService,
    private readonly replays?: ReplayService,
    private readonly evaluations?: EvalService,
    private readonly teamRuntime?: AgentRuntimeService,
    private readonly mailbox?: MailboxService,
    private readonly memories?: MemoryService,
    private readonly routines?: RoutineService,
    private readonly updates?: UpdateService,
  ) {
    this.capabilities = new CapabilitiesService(homeDirectory);
    this.agents = new AgentService(homeDirectory);
  }

  async initialize(): Promise<void> {
    this.state = await this.store.load();
    await this.controlPlane?.initialize({ conversations: this.state.conversations });
    if (this.taskScheduler) {
      await this.taskScheduler.initialize();
      await new LeaseReconciler(this.taskScheduler).reconcileExpired();
    }
    await this.workspaceLeases?.initialize();
    await this.steering?.initialize();
    await this.notifications?.initialize();
    await this.refreshRemoteHostState();
    this.remoteScreenTimer = setInterval(() => { void this.refreshRemoteHostState(); }, 3_000);
    await this.evaluations?.initialize();
    await this.traces?.applyRetention();
    await mkdir(noProjectDirectory(this.homeDirectory), { recursive: true });
    if (!this.state.conversations.length) this.createConversationInternal();
    if (this.teamRuntime) {
      await this.teamRuntime.initialize();
      await this.teamRuntime.importDefinitions(await this.agents.list(this.activeWorkingDirectory()));
    }
    await this.refreshProviderStatuses(false);
    await this.syncRemoteRoutines();
    await this.dispatchDueRoutines();
    if (this.routines) this.routineTimer = setInterval(() => { void this.syncRemoteRoutines().then(() => this.dispatchDueRoutines()).then(() => this.scheduleTaskDispatch()).catch(() => undefined); }, 60_000);
    await this.store.save(this.state);
    this.initialized = true;
    if (this.taskScheduler) {
      this.taskDispatchTimer = setInterval(() => this.scheduleTaskDispatch(), 1_000);
      this.resumeRemoteTasks();
      this.scheduleTaskDispatch();
    }
    if (this.updates) {
      this.unsubscribeUpdate = this.updates.subscribe(() => this.publishSnapshot());
      await this.updates.initialize(this.state.settings.updateChannel ?? "stable");
    }
  }

  attachWindow(window: BrowserWindow): void {
    this.window = window;
    this.unsubscribeProjection?.();
    this.unsubscribeProjection = this.controlPlane?.subscribe((change) => {
      if (this.window && !this.window.isDestroyed()) this.window.webContents.send(IPC.projectionChanged, change);
    });
    this.publishSnapshot();
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
    if (this.routineTimer) clearInterval(this.routineTimer);
    if (this.taskDispatchTimer) clearInterval(this.taskDispatchTimer);
    if (this.remoteScreenTimer) clearInterval(this.remoteScreenTimer);
    this.unsubscribeProjection?.();
    this.unsubscribeProjection = undefined;
    this.unsubscribeUpdate?.();
    this.unsubscribeUpdate = undefined;
    this.updates?.shutdown();
    for (const run of this.runs.values()) run.abort();
    for (const run of this.taskControllers.values()) run.abort();
    await Promise.allSettled(this.runTasks.values());
    await this.taskDispatchPromise?.catch(() => undefined);
    await this.remoteRefreshPromise?.catch(() => undefined);
    await this.harnessRegistry.cleanup();
    await this.toolGateway.close();
  }

  snapshot(): AppSnapshot {
    return structuredClone({
      conversations: [...this.state.conversations]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map(boundedConversationProjection),
      ...(this.state.activeConversationId ? { activeConversationId: this.state.activeConversationId } : {}),
      settings: this.state.settings,
      providerStatuses: this.statuses,
      harnesses: this.harnesses,
      computerAccess: this.computerAccess.snapshot(this.state.computerAccess, this.activeWorkingDirectory(), this.pendingApprovals[0]),
      taskGraph: this.taskScheduler?.snapshot() ?? { revision: 0, goals: [], tasks: [] },
      workspaceState: this.workspaceLeases?.snapshot() ?? { revision: 0, leases: [], integrations: [] },
      controlRuntime: this.steering?.snapshot(),
      team: this.teamRuntime?.snapshot(),
      update: this.updates?.snapshot(),
      appVersion: this.appVersion,
    });
  }

  localBackgroundWork(): LocalBackgroundWork {
    if (!this.state) return { conversationIds: [], taskIds: [] };
    return localBackgroundWork(this.state.conversations, this.taskScheduler?.snapshot().tasks ?? [], this.state.computerAccess.localDeviceId);
  }

  async createTaskGoal(draft: TaskGoalDraft): Promise<void> {
    if (!this.taskScheduler) throw new Error("The task scheduler is not available");
    const source = this.state.conversations.find((conversation) => conversation.id === this.state.activeConversationId) ?? this.state.conversations[0];
    const prepared: TaskGoalDraft = {
      ...structuredClone(draft),
      nodes: draft.nodes.map((node) => ({
        ...structuredClone(node),
        assignment: {
          ...(source ? {
            sourceConversationId: source.id,
            workspace: source.workingDirectory,
            workspaceMode: source.sandboxMode === "workspace-write" ? "write" as const : "read" as const,
            ...(this.state.computerAccess.activeDeviceId !== this.state.computerAccess.localDeviceId ? { targetHostId: this.state.computerAccess.activeDeviceId } : {}),
            ...(!node.assignment?.harnessId || node.assignment.harnessId === source.harnessId ? { model: source.model } : {}),
          } : {}),
          ...structuredClone(node.assignment ?? {}),
        },
      })),
    };
    await this.taskScheduler.createGoal(prepared);
    if (this.steering) {
      for (const node of prepared.nodes) {
        if (node.assignment?.harnessId) continue;
        const decision = await this.routeTask(node.id);
        if (decision.status === "rejected") await this.taskScheduler.applyAction(node.id, { type: "pause" });
      }
    }
    this.publishSnapshot();
    this.scheduleTaskDispatch();
  }

  async actOnTask(taskId: string, action: TaskAction): Promise<void> {
    if (!this.taskScheduler) throw new Error("The task scheduler is not available");
    await this.taskScheduler.applyAction(taskId, action);
    this.publishSnapshot();
    this.scheduleTaskDispatch();
  }

  async controlTask(taskId: string, request: TaskControlRequest): Promise<void> {
    if (!this.steering || !this.taskScheduler) throw new Error("Live task controls are not available");
    const task = this.taskScheduler.snapshot().tasks.find((entry) => entry.id === taskId);
    if (!task) throw new Error("Task was not found");
    const command = await this.steering.queue({ ...request, taskId, harnessId: task.assignment.harnessId ?? "unassigned" });
    const localAction = request.type === "pause" ? { type: "pause" as const }
      : request.type === "resume" ? { type: "resume" as const }
        : request.type === "reprioritize" && request.priority !== undefined ? { type: "reprioritize" as const, priority: request.priority }
          : request.type === "stop" ? { type: "cancel" as const }
            : null;
    const activeLease = (task.status === "leased" || task.status === "running") ? task.lease : undefined;
    const remote = this.remoteTaskClients.get(taskId);
    if (remote && activeLease) {
      const remoteType = request.type === "stop" ? "cancel" : request.type === "approve" ? "approve" : undefined;
      if (!remoteType) {
        await this.steering.deliver(command.id, async () => ({ accepted: false, reason: "This paired host currently supports cancellation and approval controls at durable boundaries" }));
      } else {
        await this.steering.deliver(command.id, () => this.computerAccess.remoteControl(remote.client, {
          id: command.id.replace(/[^a-zA-Z0-9:_-]/g, "-"), jobId: remote.jobId, leaseEpoch: remote.leaseEpoch, afterCursor: remote.cursor,
          type: remoteType, ...(remoteType === "approve" ? { decision: "allow" as const } : {}),
        }));
        if (remoteType === "cancel") {
          this.taskControllers.get(taskId)?.abort();
          await this.taskScheduler.interrupt(taskId, activeLease.id, "canceled");
        }
      }
      this.publishSnapshot();
      return;
    }
    if (activeLease && request.type === "pause") {
      this.pendingTaskPauses.set(taskId, activeLease.id);
      await this.steering.deliver(command.id, async () => ({ accepted: true, reason: "Pause queued for the next safe boundary" }));
    } else if (activeLease && request.type === "stop") {
      this.pendingTaskPauses.delete(taskId);
      this.taskControllers.get(taskId)?.abort();
      await this.taskScheduler.interrupt(taskId, activeLease.id, "canceled");
      if (task.assignment.harnessId) {
        const sessionId = this.taskSessions.get(taskId);
        await this.harnessRegistry.deliverControl(task.assignment.harnessId, { type: "cancel", ...(sessionId ? { sessionId } : {}) }).catch(() => ({ accepted: false }));
      }
      await this.steering.deliver(command.id, async () => ({ accepted: true, reason: "Canceled and fenced by the Grokky scheduler" }));
    } else if (localAction && (!activeLease || request.type === "reprioritize")) {
      await this.taskScheduler.applyAction(taskId, localAction);
      await this.steering.deliver(command.id, async () => ({ accepted: true, reason: "Applied by the Grokky scheduler" }));
    } else if (task.assignment.harnessId) {
      const control: HarnessControl | null = request.type === "stop" ? { type: "cancel" }
        : request.type === "redirect" && request.message ? { type: "steer", message: request.message }
          : (request.type === "follow-up" || request.type === "message") && request.message ? { type: "follow-up", message: request.message }
            : null;
      if (control) {
        const sessionId = this.taskSessions.get(taskId);
        await this.steering.deliver(command.id, () => this.harnessRegistry.deliverControl(task.assignment.harnessId!, { ...control, ...(sessionId ? { sessionId } : {}) }));
      }
    }
    this.publishSnapshot();
    this.scheduleTaskDispatch();
  }

  async updateControlPolicies(patch: ControlPolicyPatch): Promise<void> {
    if (!this.steering) throw new Error("Control policies are not available");
    await this.steering.repository.mutate((value) => {
      if (patch.budgetPolicy) value.budgetPolicy = structuredClone(patch.budgetPolicy);
      if (patch.routingPolicy) value.routingPolicy = structuredClone(patch.routingPolicy);
    });
    this.publishSnapshot();
  }

  async queryTrace(query: TraceQuery): Promise<TraceBundle> {
    if (!this.traces) throw new Error("Trace service is not available");
    return this.traces.query(query);
  }

  async replayTrace(request: ReplayRequest) {
    if (!this.replays) throw new Error("Replay service is not available");
    return this.replays.replay(request);
  }

  getEvaluations() {
    if (!this.evaluations) throw new Error("Evaluation service is not available");
    return this.evaluations.snapshot();
  }

  async promoteEvaluation(input: { id: string; name: string; trace: TraceBundle; expectedOutcome: string; allowedSideEffects?: string[]; verificationRules: EvalVerificationRule[] }) {
    if (!this.evaluations) throw new Error("Evaluation service is not available");
    await this.evaluations.promote(input);
    return this.evaluations.snapshot();
  }

  async gradeEvaluation(caseId: string, version: number, trace: TraceBundle, metrics: EvalMetricSet) {
    if (!this.evaluations) throw new Error("Evaluation service is not available");
    await this.evaluations.grade(caseId, version, trace, metrics);
    return this.evaluations.snapshot();
  }

  compareEvaluations(baselineId: string, candidateId: string) {
    if (!this.evaluations) throw new Error("Evaluation service is not available");
    return this.evaluations.compare(baselineId, candidateId);
  }

  async checkForUpdate(): Promise<void> {
    if (!this.updates) throw new Error("Automatic updates are not available");
    await this.updates.checkForUpdates();
  }

  async downloadUpdate(): Promise<void> {
    if (!this.updates) throw new Error("Automatic updates are not available");
    await this.updates.downloadUpdate();
  }

  async installUpdate(): Promise<string[]> {
    if (!this.updates) throw new Error("Automatic updates are not available");
    return this.updates.installUpdate();
  }

  async setUpdateChannel(channel: "stable" | "beta"): Promise<void> {
    if (!this.updates) throw new Error("Automatic updates are not available");
    await this.updates.setChannel(channel);
    this.state.settings.updateChannel = channel;
    await this.store.save(this.state);
    this.publishSnapshot();
  }

  updateRestartBlockers(): string[] {
    const blockers: string[] = [];
    if (!this.initialized) blockers.push("Database migrations are still running");
    const activeConversations = this.state?.conversations.filter((conversation) => conversation.status === "running").length ?? 0;
    if (activeConversations) blockers.push(`${activeConversations} local conversation${activeConversations === 1 ? " is" : "s are"} still running`);
    const tasks = this.taskScheduler?.snapshot().tasks ?? [];
    const activeTasks = tasks.filter((task) => task.status === "leased" || task.status === "running").length;
    if (activeTasks) blockers.push(`${activeTasks} task${activeTasks === 1 ? " has" : "s have"} an active execution lease`);
    const integrations = this.workspaceLeases?.snapshot().integrations ?? [];
    const unresolvedIntegrations = integrations.filter((entry) => new Set(["queued", "integrating", "conflict"]).has(entry.status)).length;
    if (unresolvedIntegrations) blockers.push(`${unresolvedIntegrations} workspace integration${unresolvedIntegrations === 1 ? " is" : "s are"} unresolved`);
    if (this.pendingApprovals.length) blockers.push(`${this.pendingApprovals.length} operator approval${this.pendingApprovals.length === 1 ? " is" : "s are"} pending`);
    const access = this.state ? this.computerAccess.snapshot(this.state.computerAccess, this.activeWorkingDirectory(), this.pendingApprovals[0]) : undefined;
    const remote = access?.devices.find((device) => device.id === access.activeDeviceId && device.kind === "remote");
    if (remote?.status === "offline" && activeTasks > 0) blockers.push("The selected remote host has not reconciled its active task state");
    return blockers;
  }

  async routeTask(taskId: string): Promise<RouteDecision> {
    if (!this.steering || !this.taskScheduler) throw new Error("Task routing is not available");
    const runtime = this.steering.snapshot();
    const task = this.taskScheduler.snapshot().tasks.find((entry) => entry.id === taskId);
    if (!task) throw new Error("Task was not found");
    const decision = new PolicyEngine().route(this.harnesses, {
      ...runtime.routingPolicy,
      requiredCapabilities: {
        ...runtime.routingPolicy.requiredCapabilities,
        ...this.taskRequiredCapabilities(task.assignment.requiredCapabilities),
      },
    });
    await this.steering.repository.mutate((value) => { value.routeDecisions.push({ ...decision, taskId }); });
    if (decision.status === "selected") {
      await this.taskScheduler.applyAction(taskId, { type: "assign", assignment: { ...task.assignment, harnessId: decision.harnessId, model: decision.model } });
    }
    return decision;
  }

  async evaluateTaskBudget(taskId: string, measurements: BudgetMeasurements, enforceableBoundary: boolean): Promise<BudgetDecision> {
    if (!this.steering) throw new Error("Task budgets are not available");
    const decision = new BudgetService().evaluate(this.steering.snapshot().budgetPolicy, measurements, { enforceableBoundary });
    await this.steering.repository.mutate((value) => { value.budgetDecisions.push({ ...decision, taskId }); });
    if (decision.status === "paused" || decision.status === "blocked") {
      await this.notifications?.notify({ type: "budget-pause", title: "Task paused by budget", body: decision.reason, taskId });
      await this.controlTask(taskId, { type: decision.status === "blocked" ? "stop" : "pause", idempotencyKey: `budget:${taskId}:${decision.metric}:${decision.threshold}` });
    }
    this.publishSnapshot();
    return decision;
  }

  async acquireTaskWorkspace(request: WorkspaceLeaseRequest): Promise<WorkspaceLease> {
    if (!this.workspaceLeases || !this.taskScheduler) throw new Error("Workspace isolation is not available");
    if (!this.taskScheduler.snapshot().tasks.some((task) => task.id === request.taskId)) throw new Error("Task was not found");
    const lease = await this.workspaceLeases.acquire(request);
    this.publishSnapshot();
    return lease;
  }

  async transferTaskWorkspace(leaseId: string, holderId: string): Promise<WorkspaceLease> {
    if (!this.workspaceLeases) throw new Error("Workspace isolation is not available");
    const lease = await this.workspaceLeases.transfer(leaseId, holderId);
    this.publishSnapshot();
    return lease;
  }

  async integrateTaskWorkspace(leaseId: string, targetRef: string, verification: VerificationCommand[] = []): Promise<IntegrationRecord> {
    if (!this.workspaceLeases || !this.integrationQueue) throw new Error("Workspace integration is not available");
    const lease = this.workspaceLeases.snapshot().leases.find((entry) => entry.id === leaseId);
    if (!lease?.branch || lease.kind !== "git") throw new Error("Only a Git worktree lease can be integrated");
    const repository = await GitRepository.open(lease.root);
    const result = await this.integrationQueue.integrate({ taskId: lease.taskId, leaseId, repository, taskBranch: lease.branch, targetRef }, verification);
    if (result.status === "succeeded") await this.workspaceLeases.markIntegrated(leaseId);
    else if (result.status === "conflict") await this.notifications?.notify({ type: "integration-conflict", title: "Integration conflict", body: result.conflictFiles?.join(", ") || result.error || "Resolve the integration conflict", taskId: lease.taskId });
    this.publishSnapshot();
    return result;
  }

  async createConversation(): Promise<string> {
    const conversation = this.createConversationInternal();
    await this.commit();
    return conversation.id;
  }

  private createConversationInternal(): Conversation {
    const now = Date.now();
    const workingDirectory = this.state?.settings.defaultWorkingDirectory || noProjectDirectory(this.homeDirectory);
    const projectMode = resolve(workingDirectory) === resolve(noProjectDirectory(this.homeDirectory)) ? "none" : "project";
    const conversation: Conversation = {
      id: id(),
      title: "New session",
      provider: "codex",
      harnessId: this.harnessRegistry.compatibilityId("codex"),
      model: CODEX_MODELS[0],
      reasoning: "medium",
      sandboxMode: "workspace-write",
      allowCommands: false,
      projectMode,
      workingDirectory,
      messages: [],
      activities: [],
      selectedAgentIds: [],
      agentRuns: [],
      crewCommunications: [],
      harnessAttempts: [],
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    this.state.conversations.unshift(conversation);
    this.state.activeConversationId = conversation.id;
    return conversation;
  }

  async setActiveConversation(conversationId: string): Promise<void> {
    this.requireConversation(conversationId);
    this.state.activeConversationId = conversationId;
    await this.commit();
  }

  async updateConversation(conversationId: string, patch: ConversationPatch): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    if (conversation.status === "running") throw new Error("Stop the current run before changing its configuration");
    const nextPatch = { ...patch };
    if (nextPatch.projectMode === "none") {
      nextPatch.workingDirectory = noProjectDirectory(this.homeDirectory);
      nextPatch.allowCommands = false;
    } else if (nextPatch.workingDirectory !== undefined) {
      nextPatch.workingDirectory = await requireDirectory(nextPatch.workingDirectory);
      nextPatch.projectMode = "project";
    }
    if (nextPatch.provider && nextPatch.provider !== conversation.provider) {
      conversation.threadId = undefined;
      conversation.model = nextPatch.provider === "codex" ? CODEX_MODELS[0] : nextPatch.provider === "pi" ? DEFAULT_PI_MODEL : DEFAULT_OPENROUTER_MODEL;
      conversation.harnessId = this.harnessRegistry.compatibilityId(nextPatch.provider);
      if (nextPatch.provider === "pi") conversation.selectedAgentIds = [];
    }
    if (
      (nextPatch.projectMode !== undefined && nextPatch.projectMode !== conversation.projectMode)
      || (nextPatch.workingDirectory !== undefined && resolve(nextPatch.workingDirectory) !== resolve(conversation.workingDirectory))
    ) {
      conversation.threadId = undefined;
    }
    Object.assign(conversation, nextPatch, { updatedAt: Date.now(), error: undefined });
    if (conversation.projectMode === "project") this.rememberProject(conversation.workingDirectory);
    await this.commit();
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.runs.get(conversationId)?.abort();
    this.runs.delete(conversationId);
    const index = this.state.conversations.findIndex((item) => item.id === conversationId);
    if (index < 0) throw new Error("Conversation not found");
    this.state.conversations.splice(index, 1);
    if (!this.state.conversations.length) this.createConversationInternal();
    if (this.state.activeConversationId === conversationId) this.state.activeConversationId = this.state.conversations[0]?.id;
    await this.commit();
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    if (conversation.status === "running") throw new Error("This conversation is already running");
    await requireDirectory(conversation.workingDirectory);
    if (conversation.projectMode === "none" && requiresProjectDirectory(text)) {
      throw new Error("Choose a project folder before Grokky starts this work. Use the project menu below the message box, then choose or create a folder.");
    }
    if (requiresDevelopmentCommands(text) && !conversation.allowCommands) {
      throw new Error("This request needs local development commands. Choose Full access below the message box before sending it.");
    }
    const providerStatus = this.statuses.find((status) => status.id === conversation.provider);
    if (!providerStatus?.ready) throw new Error(providerStatus?.detail || `${conversation.provider} is not configured`);
    const adapter = this.harnessRegistry.resolve(conversation);
    this.harnessRegistry.requireCompatible(adapter.descriptor.id, this.requiredHarnessCapabilities(conversation));

    const now = Date.now();
    const message: ChatMessage = { id: id(), role: "user", content: text, createdAt: now, provider: conversation.provider };
    conversation.messages.push(message);
    if (conversation.messages.length === 1) conversation.title = titleFromMessage(text);
    conversation.activities = [];
    conversation.agentRuns = [];
    conversation.crewCommunications = [];
    conversation.status = "running";
    conversation.lastRunOutcome = undefined;
    conversation.error = undefined;
    conversation.updatedAt = now;
    const controller = new AbortController();
    const runId = id();
    const harnessAttempt: HarnessAttempt = {
      id: runId,
      harnessId: adapter.descriptor.id,
      adapterVersion: adapter.descriptor.version,
      status: "running",
      startedAt: now,
    };
    conversation.harnessId = adapter.descriptor.id;
    conversation.harnessAttempts = [...(conversation.harnessAttempts ?? []), harnessAttempt].slice(-40);
    this.runs.set(conversationId, controller);
    this.runIds.set(conversationId, runId);
    await this.recordConversationEvent(conversation, "conversation.snapshot", { conversation: boundedConversationProjection(conversation) }, runId);
    await this.recordConversationEvent(conversation, "run.started", { promptMessageId: message.id }, runId);
    await this.commit();
    const task = this.executeRun(conversationId, text, controller);
    this.runTasks.set(conversationId, task);
    void task.finally(() => {
      if (this.runTasks.get(conversationId) === task) this.runTasks.delete(conversationId);
    });
  }

  async cancelRun(conversationId: string): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    this.runs.get(conversationId)?.abort();
    this.runs.delete(conversationId);
    const runId = this.runIds.get(conversationId);
    this.runIds.delete(conversationId);
    this.denyPendingApprovals(conversationId);
    conversation.status = "idle";
    conversation.lastRunOutcome = "stopped";
    conversation.error = "Run stopped";
    conversation.agentRuns = conversation.agentRuns.map((run) => (
      new Set<AgentRunStatus>(["starting", "working", "waiting"]).has(run.status)
        ? { ...run, status: "stopped" as const, updatedAt: Date.now() }
        : run
    ));
    conversation.updatedAt = Date.now();
    this.finishHarnessAttempt(conversation, runId, "stopped");
    await this.recordConversationEvent(conversation, "run.stopped", { reason: "operator" }, runId);
    await this.commit();
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    Object.assign(this.state.settings, patch);
    await this.refreshProviderStatuses(false);
    await this.commit();
  }

  async setComputerAccessEnabled(enabled: boolean): Promise<void> {
    this.state.computerAccess.enabled = enabled;
    if (!enabled) {
      for (const conversation of this.state.conversations) this.denyPendingApprovals(conversation.id);
      this.sessionComputerGrants.clear();
    }
    await this.commit();
  }

  async setComputerCapability(capability: ComputerCapabilityId, level: ComputerAccessLevel): Promise<void> {
    this.computerAccess.setCapability(this.state.computerAccess, capability, level);
    if (level !== "allow") {
      for (const grants of this.sessionComputerGrants.values()) grants.delete(capability);
    }
    await this.commit();
  }

  async requestComputerPermission(capability: ComputerCapabilityId): Promise<void> {
    await this.computerAccess.requestPermission(capability);
    await this.commit();
  }

  async testComputerCapability(capability: ComputerCapabilityId): Promise<void> {
    const conversation = this.requireConversation(this.state.activeConversationId || this.state.conversations[0]!.id);
    const target = capability === "files" || capability === "commands" ? conversation.workingDirectory : "local capability check";
    try {
      const detail = await this.computerAccess.test(this.state.computerAccess, capability, conversation);
      const audit = this.appendComputerAudit(conversation, capability, `test_${capability}`, target, "allowed", "completed", detail.slice(0, 2_000));
      await this.recordAuditEvent(conversation, audit);
    } catch (error) {
      const audit = this.appendComputerAudit(conversation, capability, `test_${capability}`, target, "allowed", "failed", error instanceof Error ? error.message : "Capability test failed");
      await this.recordAuditEvent(conversation, audit);
      await this.commit();
      throw error;
    }
    await this.commit();
  }

  async pairComputer(endpoint: string, code: string): Promise<void> {
    await this.computerAccess.pair(this.state.computerAccess, endpoint, code);
    await this.refreshRemoteScreens();
    await this.commit();
  }

  async selectComputer(deviceId: string): Promise<void> {
    this.computerAccess.select(this.state.computerAccess, deviceId);
    await this.refreshRemoteScreens();
    await this.commit();
  }

  async revokeComputer(deviceId: string): Promise<void> {
    this.computerAccess.revoke(this.state.computerAccess, deviceId);
    await this.commit();
  }

  private async refreshRemoteScreens(): Promise<void> {
    try {
      const changed = await this.computerAccess.refreshRemoteScreens(this.state.computerAccess);
      if (changed && this.initialized) this.publishSnapshot();
    } catch {
      // Files-only runners and temporarily disconnected hosts have no screen projection to refresh.
    }
  }

  private refreshRemoteHostState(): Promise<void> {
    if (this.remoteRefreshPromise) return this.remoteRefreshPromise;
    const operation = Promise.allSettled([this.refreshRemoteScreens(), this.reconcileRemoteHostEvents()]).then(() => undefined);
    this.remoteRefreshPromise = operation;
    void operation.finally(() => { if (this.remoteRefreshPromise === operation) this.remoteRefreshPromise = undefined; });
    return operation;
  }

  private async reconcileRemoteHostEvents(): Promise<void> {
    if (!this.controlPlane) return;
    const batches = await this.computerAccess.pollRemoteEvents(this.state.computerAccess);
    const knownTaskJobs = this.knownRemoteTaskJobIds();
    let changed = false;
    for (const { deviceId, frames } of batches) {
      for (const frame of frames) {
        if (knownTaskJobs.has(frame.jobId)) continue;
        const result = await this.controlPlane.record({
          id: `remote:${frame.jobId}:${frame.cursor}`,
          aggregateId: frame.jobId,
          source: "grokky.remote-host",
          type: "diagnostic.recorded",
          payload: { remote: { deviceId, cursor: frame.cursor, type: frame.type, payload: frame.payload } },
          timestamp: frame.timestamp,
        });
        if (result.status === "appended") {
          changed = true;
          await this.notifyRemoteHostFrame(frame);
        }
      }
      if (frames.length) {
        const device = this.state.computerAccess.remoteDevices.find((entry) => entry.id === deviceId);
        if (device) device.eventCursor = Math.max(device.eventCursor, ...frames.map((frame) => frame.cursor));
      }
    }
    if (batches.some((batch) => batch.frames.length)) await this.store.save(this.state);
    if (changed && this.initialized) this.publishSnapshot();
  }

  private knownRemoteTaskJobIds(): Set<string> {
    const result = new Set(Array.from(this.remoteTaskClients.values(), ({ jobId }) => jobId));
    for (const task of this.taskScheduler?.snapshot().tasks ?? []) {
      const cursor = task.checkpoints.at(-1)?.cursor;
      if (!cursor?.startsWith("remote:")) continue;
      try {
        const jobId = (JSON.parse(cursor.slice("remote:".length)) as { jobId?: unknown }).jobId;
        if (typeof jobId === "string") result.add(jobId);
      } catch {
        // Invalid checkpoints are handled by the task reconciler.
      }
    }
    return result;
  }

  private async notifyRemoteHostFrame(frame: RemoteEventFrame): Promise<void> {
    if (frame.type === "job.approval") await this.notifications?.notify({ type: "approval", title: "Remote routine needs approval", body: "An unattended routine is waiting on its paired host." });
    if (frame.type === "job.completed") await this.notifications?.notify({ type: "task-terminal", title: "Remote routine step completed", body: this.remoteSummary(frame.payload, "The unattended routine step completed.") });
    if (frame.type === "job.failed" || frame.type === "job.canceled") await this.notifications?.notify({ type: "routine-failed", title: "Remote routine step failed", body: this.remoteSummary(frame.payload, `The unattended routine step ${frame.type === "job.canceled" ? "was canceled" : "failed"}.`) });
  }

  async updateComputerNetworkAllowlist(domains: string[]): Promise<void> {
    this.state.computerAccess.networkAllowlist = [...new Set(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean))].slice(0, 100);
    await this.commit();
  }

  async takeoverScreen(leaseId: string, epoch: number): Promise<void> { await this.computerAccess.takeoverScreen(this.state.computerAccess, leaseId, epoch); this.publishSnapshot(); }
  async returnScreen(leaseId: string, epoch: number): Promise<void> { await this.computerAccess.returnScreen(this.state.computerAccess, leaseId, epoch); this.publishSnapshot(); }
  async lockScreen(leaseId: string, epoch: number): Promise<void> { await this.computerAccess.lockScreen(this.state.computerAccess, leaseId, epoch); this.publishSnapshot(); }

  async resolveComputerApproval(approvalId: string, decision: ComputerApprovalDecision): Promise<void> {
    const index = this.pendingApprovals.findIndex((approval) => approval.id === approvalId);
    if (index < 0) throw new Error("Computer approval is no longer pending");
    const approval = this.pendingApprovals[index]!;
    this.pendingApprovals.splice(index, 1);
    if (decision === "allow-session") {
      const grants = this.sessionComputerGrants.get(approval.conversationId) ?? new Set<ComputerCapabilityId>();
      grants.add(approval.capability);
      this.sessionComputerGrants.set(approval.conversationId, grants);
    }
    this.approvalResolvers.get(approvalId)?.(decision);
    this.approvalResolvers.delete(approvalId);
    const conversation = this.requireConversation(approval.conversationId);
    await this.recordConversationEvent(conversation, "approval.resolved", { approvalId, decision }, this.runIds.get(conversation.id));
    this.publishSnapshot();
  }

  async refreshProviderStatuses(publish = true): Promise<void> {
    this.harnesses = await this.harnessRegistry.snapshot(this.state.settings, this.homeDirectory);
    this.statuses = this.harnessRegistry.providerStatuses(this.harnesses);
    if (publish) await this.commit();
  }

  async getCapabilities(): Promise<CapabilitiesSnapshot> {
    const [snapshot, configurations] = await Promise.all([
      this.capabilities.snapshot(this.activeWorkingDirectory()),
      this.capabilities.mcpServerConfigurations(),
    ]);
    return this.mergeMcpCapabilities(snapshot, configurations, this.toolGateway.cached().results);
  }

  async refreshMcpCapabilities(): Promise<CapabilitiesSnapshot> {
    const [snapshot, configurations] = await Promise.all([
      this.capabilities.snapshot(this.activeWorkingDirectory()),
      this.capabilities.mcpServerConfigurations(),
    ]);
    const prepared = await this.toolGateway.prepare(configurations, this.state.settings.mcpToolPolicies ?? {});
    return this.mergeMcpCapabilities(snapshot, configurations, prepared.results);
  }

  private mergeMcpCapabilities(
    snapshot: CapabilitiesSnapshot,
    configurations: Awaited<ReturnType<CapabilitiesService["mcpServerConfigurations"]>>,
    results: ReturnType<ToolGateway["cached"]>["results"],
  ): CapabilitiesSnapshot {
    return {
      ...snapshot,
      mcpServers: snapshot.mcpServers.map((server) => {
        const result = results.find((candidate) => candidate.serverId === server.id);
        if (!server.enabled) return { ...server, status: "idle" as const, tools: [] };
        if (!configurations.some((configuration) => configuration.id === server.id)) return { ...server, status: "error" as const, detail: "The MCP server transport configuration is unsupported.", tools: [] };
        if (!result) return { ...server, status: "idle" as const, detail: "Refresh to discover tools through the main-process gateway.", tools: [] };
        return {
          ...server,
          status: result.status,
          ...(result.detail ? { detail: result.status === "authorization-required" ? "Authorization is required." : "Connection failed; inspect the main-process diagnostic log." } : {}),
          tools: result.tools.map(({ serverId: _server, originalName: _original, inputSchema: _schema, toolDefinition: _definition, ...tool }) => tool),
        };
      }),
    };
  }

  async setSkillEnabled(pathname: string, enabled: boolean): Promise<CapabilitiesSnapshot> {
    return this.capabilities.setSkillEnabled(pathname, enabled, this.activeWorkingDirectory());
  }

  async setMcpEnabled(id: string, enabled: boolean): Promise<CapabilitiesSnapshot> {
    await this.capabilities.setMcpEnabled(id, enabled, this.activeWorkingDirectory());
    return this.refreshMcpCapabilities();
  }

  async setMcpToolClassification(name: string, classification: McpToolClassification): Promise<CapabilitiesSnapshot> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(name)) throw new Error("Invalid MCP tool name");
    if (!new Set<McpToolClassification>(["read", "write", "external-side-effect", "human-only"]).has(classification)) throw new Error("Invalid MCP tool classification");
    this.state.settings.mcpToolPolicies = { ...(this.state.settings.mcpToolPolicies ?? {}), [name]: classification };
    await this.commit();
    return this.refreshMcpCapabilities();
  }

  async beginMcpAuthorization(serverId: string): Promise<string> {
    const configuration = await this.requireRemoteMcpConfiguration(serverId);
    return this.toolGateway.clients.auth.begin(serverId, configuration.url!);
  }

  async completeMcpAuthorization(serverId: string, callback: string): Promise<CapabilitiesSnapshot> {
    const configuration = await this.requireRemoteMcpConfiguration(serverId);
    await this.toolGateway.clients.auth.complete(serverId, configuration.url!, callback);
    return this.refreshMcpCapabilities();
  }

  async revokeMcpAuthorization(serverId: string): Promise<CapabilitiesSnapshot> {
    const configuration = await this.requireRemoteMcpConfiguration(serverId);
    await this.toolGateway.clients.auth.revoke(serverId, configuration.url!);
    return this.refreshMcpCapabilities();
  }

  async setConnectorEnabled(id: string, enabled: boolean): Promise<CapabilitiesSnapshot> {
    return this.capabilities.setConnectorEnabled(id, enabled, this.activeWorkingDirectory());
  }

  async getAgents(): Promise<AgentDefinition[]> {
    const agents = await this.agents.list(this.activeWorkingDirectory());
    await this.teamRuntime?.importDefinitions(agents);
    return agents;
  }

  async createAgent(draft: AgentDraft): Promise<AgentDefinition[]> {
    const agents = await this.agents.create(draft, this.activeWorkingDirectory());
    await this.teamRuntime?.importDefinitions(agents);
    this.publishSnapshot();
    return agents;
  }

  async updateAgent(agentId: string, draft: AgentDraft): Promise<AgentDefinition[]> {
    const agents = await this.agents.update(agentId, draft, this.activeWorkingDirectory());
    await this.teamRuntime?.importDefinitions(agents);
    this.publishSnapshot();
    return agents;
  }

  async deleteAgent(agentId: string): Promise<AgentDefinition[]> {
    const assigned = this.taskScheduler?.snapshot().tasks.filter((task) => task.assignment.agentId === agentId && !new Set(["succeeded", "failed", "canceled"]).has(task.status)) ?? [];
    if (assigned.length) throw new Error(`Reassign or cancel ${assigned.length} active task(s) before deleting this agent`);
    const agents = await this.agents.delete(agentId, this.activeWorkingDirectory());
    const valid = new Set(agents.map((agent) => agent.id));
    for (const conversation of this.state.conversations) {
      conversation.selectedAgentIds = conversation.selectedAgentIds.filter((id) => valid.has(id));
    }
    await this.commit();
    await this.teamRuntime?.setStatus(agentId, "deleted");
    return agents;
  }

  async sendAgentMessage(input: Omit<AgentMailboxMessage, "id" | "acknowledgedBy" | "createdAt">) {
    if (!this.mailbox) throw new Error("Agent mailbox is not available");
    const message = await this.mailbox.send(input);
    this.publishSnapshot();
    return message;
  }

  async acknowledgeAgentMessage(messageId: string, agentId: string) {
    if (!this.mailbox) throw new Error("Agent mailbox is not available");
    const message = await this.mailbox.acknowledge(messageId, agentId);
    this.publishSnapshot();
    return message;
  }

  async proposeAgentMemory(input: Pick<AgentMemory, "agentId" | "kind" | "content" | "sourceReferences">) {
    if (!this.memories) throw new Error("Agent memory is not available");
    const memory = await this.memories.propose(input);
    this.publishSnapshot();
    return memory;
  }

  async reviewAgentMemory(id: string, decision: "reviewed" | "rejected") {
    if (!this.memories) throw new Error("Agent memory is not available");
    const memory = await this.memories.review(id, decision);
    this.publishSnapshot();
    return memory;
  }

  async createAgentRoutine(input: Omit<AgentRoutine, "id" | "version" | "nextFireAt" | "lastOccurrenceKey" | "createdAt" | "updatedAt">) {
    if (!this.routines) throw new Error("Agent routines are not available");
    const routine = await this.routines.create(input);
    if (this.isRemoteRoutine(routine)) await this.syncRemoteRoutine(routine).catch((error) => this.notifyRoutineSyncFailure(routine, error));
    this.publishSnapshot();
    return routine;
  }

  async updatePersistentAgent(agentId: string, action: "pin" | "unpin" | "hide" | "archive" | "restore" | "delete") {
    if (!this.teamRuntime) throw new Error("Persistent agent runtime is not available");
    const active = this.taskScheduler?.snapshot().tasks.filter((task) => task.assignment.agentId === agentId && !new Set(["succeeded", "failed", "canceled"]).has(task.status)) ?? [];
    if (action === "delete" && active.length) throw new Error(`Reassign or cancel ${active.length} active task(s) before deleting this agent`);
    if (action === "pin" || action === "unpin") await this.teamRuntime.setPinned(agentId, action === "pin");
    else await this.teamRuntime.setStatus(agentId, action === "restore" ? "active" : action === "hide" ? "hidden" : action === "archive" ? "archived" : "deleted");
    this.publishSnapshot();
    return this.teamRuntime.snapshot();
  }

  async duplicatePersistentAgent(agentId: string, name: string) {
    if (!this.teamRuntime) throw new Error("Persistent agent runtime is not available");
    await this.teamRuntime.duplicate(agentId, name);
    this.publishSnapshot();
    return this.teamRuntime.snapshot();
  }

  private async dispatchDueRoutines(): Promise<void> {
    if (!this.routines || !this.taskScheduler) return;
    const occurrences = (await this.routines.due()).filter(({ routine }) => !this.isRemoteRoutine(routine));
    for (const { routine, occurrenceKey } of occurrences) {
      const prefix = occurrenceKey.replace(/[^a-zA-Z0-9:_-]/g, "-");
      const idMap = new Map(routine.template.nodes.map((node) => [node.id, `${prefix}:${node.id}`]));
      const alreadyQueued = this.taskScheduler.snapshot().goals.some((goal) => goal.id === prefix);
      if (!alreadyQueued) {
        await this.taskScheduler.createGoal({
          ...structuredClone(routine.template),
          id: prefix,
          title: `${routine.name} · ${new Date(routine.nextFireAt).toLocaleDateString()}`,
          nodes: routine.template.nodes.map((node) => ({
            ...structuredClone(node),
            id: idMap.get(node.id)!,
            dependsOn: (node.dependsOn ?? []).map((id) => idMap.get(id) ?? id),
            assignment: {
              ...node.assignment,
              agentId: node.assignment?.agentId ?? routine.ownerAgentId,
              ...(routine.targetHostId !== "local" ? { targetHostId: routine.targetHostId } : {}),
              budgetUsd: node.assignment?.budgetUsd ?? routine.budgetUsd,
              approvalPolicy: node.assignment?.approvalPolicy ?? (routine.approvalBoundary === "never" ? "allow" : "ask"),
            },
          })),
        });
      }
      await this.routines.acknowledge(routine.id, occurrenceKey);
      if (!alreadyQueued) await this.notifications?.notify({ type: "routine-due", title: `Routine started: ${routine.name}`, body: "A scheduled task graph was queued.", taskId: idMap.values().next().value });
    }
    if (occurrences.length) this.publishSnapshot();
  }

  private isRemoteRoutine(routine: AgentRoutine): boolean {
    return routine.targetHostId !== "local" && routine.targetHostId !== this.state.computerAccess.localDeviceId;
  }

  private async syncRemoteRoutines(): Promise<void> {
    if (!this.routines || !this.teamRuntime) return;
    const routines = this.teamRuntime.snapshot().routines.filter((routine) => this.isRemoteRoutine(routine));
    await Promise.all(routines.map((routine) => this.syncRemoteRoutine(routine).catch((error) => this.notifyRoutineSyncFailure(routine, error))));
  }

  private async syncRemoteRoutine(routine: AgentRoutine): Promise<void> {
    if (!this.routines) return;
    const source = this.state.conversations.find((conversation) => conversation.id === this.state.activeConversationId) ?? this.state.conversations[0];
    if (!source) throw new Error("Remote routine registration requires a source conversation");
    const owner = this.teamRuntime?.snapshot().agents.find((agent) => agent.id === routine.ownerAgentId)?.profile;
    const nodes: RemoteRoutineRegistration["nodes"] = routine.template.nodes.map((node) => {
      const harnessId = node.assignment?.harnessId ?? source.harnessId;
      if (!harnessId) throw new Error(`Routine node ${node.id} has no harness assignment`);
      const descriptor = this.harnesses.find((entry) => entry.id === harnessId);
      if (!descriptor) throw new Error(`Routine harness ${harnessId} is not registered`);
      const model = node.assignment?.model ?? (source.harnessId === harnessId ? source.model : descriptor.models[0]?.id);
      if (!model) throw new Error(`Routine node ${node.id} has no model assignment`);
      return {
        id: node.id,
        dependsOn: node.dependsOn ?? [],
        harnessId,
        payload: {
          prompt: node.description || node.title,
          model,
          reasoning: owner?.reasoning ?? source.reasoning,
          sandboxMode: node.assignment?.workspaceMode === "read" ? "read-only" : owner?.sandboxMode ?? source.sandboxMode,
          allowCommands: node.assignment?.workspaceMode !== "read" && source.allowCommands,
          ...(owner ? { agents: [owner] } : {}),
          ...(node.assignment?.screenKind ? { screenKind: node.assignment.screenKind } : {}),
        },
        approvalPolicy: node.assignment?.approvalPolicy ?? (routine.approvalBoundary === "never" ? "allow" : "ask"),
        budgetUsd: node.assignment?.budgetUsd ?? routine.budgetUsd,
      };
    });
    const remote = await this.computerAccess.upsertRemoteRoutine(this.state.computerAccess, routine.targetHostId, { id: routine.id, version: routine.version, enabled: routine.active, schedule: routine.schedule, nextFireAt: routine.nextFireAt, nodes });
    await this.routines.alignRemote(routine.id, { nextFireAt: remote.nextFireAt, ...(remote.lastOccurrenceKey ? { lastOccurrenceKey: remote.lastOccurrenceKey } : {}) });
    this.routineSyncFailures.delete(routine.id);
  }

  private async notifyRoutineSyncFailure(routine: AgentRoutine, error: unknown): Promise<void> {
    if (this.routineSyncFailures.has(routine.id)) return;
    await this.notifications?.notify({ type: "routine-failed", title: `Routine host unavailable: ${routine.name}`, body: error instanceof Error ? error.message : "Remote routine registration failed" });
    this.routineSyncFailures.add(routine.id);
  }

  private scheduleTaskDispatch(): void {
    if (!this.initialized || !this.taskScheduler || this.taskDispatchPromise) return;
    const run = this.taskScheduler.dispatchReady((claim) => this.executeTaskClaim(claim)).then(async (results) => {
      for (const result of results) {
        const currentStatus = this.taskScheduler?.snapshot().tasks.find((task) => task.id === result.taskId)?.status;
        if (result.status === "failed" && currentStatus !== "paused" && currentStatus !== "canceled") {
          await this.notifications?.notify({
            type: "task-terminal",
            title: "Task needs attention",
            body: result.error ?? "A task run failed.",
            taskId: result.taskId,
          });
        }
      }
      if (results.length) this.publishSnapshot();
    }).finally(() => {
      if (this.taskDispatchPromise === run) this.taskDispatchPromise = undefined;
      if (this.initialized && this.taskScheduler?.snapshot().tasks.some((task) => task.status === "queued")) {
        queueMicrotask(() => this.scheduleTaskDispatch());
      }
    });
    this.taskDispatchPromise = run;
  }

  private async executeTaskClaim(claim: TaskLeaseClaim): Promise<{ summary: string; settledExternally?: boolean }> {
    const assignment = claim.task.assignment;
    const source = this.state.conversations.find((conversation) => conversation.id === assignment.sourceConversationId)
      ?? this.state.conversations.find((conversation) => conversation.id === this.state.activeConversationId)
      ?? this.state.conversations[0];
    if (!source) throw new Error("Task execution requires a source conversation");
    const harnessId = assignment.harnessId ?? source.harnessId;
    if (!harnessId) throw new Error("Task execution requires an assigned harness");
    const descriptor = this.harnesses.find((entry) => entry.id === harnessId);
    if (!descriptor) throw new Error(`Harness ${harnessId} is not registered`);
    const model = assignment.model ?? (source.harnessId === harnessId ? source.model : descriptor.models[0]?.id) ?? "auto";
    if (!descriptor.models.some((entry) => entry.dynamic || entry.id === model)) throw new Error(`Model ${model} is not supported by harness ${harnessId}`);
    if (assignment.targetHostId && assignment.targetHostId !== this.state.computerAccess.localDeviceId) {
      return this.executeRemoteTaskClaim(claim, source, harnessId, model);
    }
    if (!descriptor.health.ready) throw new Error(descriptor.health.detail || `Harness ${harnessId} is not ready`);
    if (!this.workspaceLeases) throw new Error("Workspace isolation is required to execute task graphs");
    const workspace = assignment.workspace ?? source.workingDirectory;
    const workspaceMode = assignment.workspaceMode ?? (source.sandboxMode === "workspace-write" ? "write" : "read");
    const workspaceLease = await this.workspaceLeases.acquire({
      taskId: claim.task.id,
      holderId: claim.lease.attemptId,
      workspace,
      mode: workspaceMode,
    });
    const now = Date.now();
    const conversation: Conversation = {
      ...structuredClone(source),
      title: claim.task.title,
      provider: descriptor.providerCompatibility.includes(source.provider) ? source.provider : descriptor.providerCompatibility[0] ?? source.provider,
      harnessId,
      model,
      sandboxMode: workspaceLease.writable ? "workspace-write" : "read-only",
      allowCommands: workspaceLease.writable && source.allowCommands,
      projectMode: "project",
      workingDirectory: workspaceLease.root,
      threadId: assignment.agentId
        ? this.teamRuntime?.snapshot().agents.find((agent) => agent.id === assignment.agentId)?.sessionReferences[harnessId]
        : undefined,
      messages: [],
      activities: [],
      selectedAgentIds: assignment.agentId ? [assignment.agentId] : [],
      agentRuns: [],
      crewCommunications: [],
      harnessAttempts: [],
      usage: undefined,
      status: "running",
      lastRunOutcome: undefined,
      error: undefined,
      createdAt: now,
      updatedAt: now,
    };
    const controller = new AbortController();
    this.taskControllers.set(claim.task.id, controller);
    const startedAt = Date.now();
    let heartbeatFailure: Error | undefined;
    const heartbeat = setInterval(() => {
      void this.taskScheduler?.heartbeat(claim.task.id, claim.lease.id).catch((error) => {
        heartbeatFailure = error instanceof Error ? error : new Error("Task lease heartbeat failed");
        controller.abort();
      });
    }, 5_000);
    let finalText = "";
    let usage: UsageSummary | undefined;
    try {
      if (this.steering) {
        const decision = await this.evaluateTaskBudget(claim.task.id, {
          elapsedMs: { value: 0, quality: "authoritative" },
          concurrency: { value: this.taskScheduler?.snapshot().tasks.filter((task) => task.status === "leased" || task.status === "running").length ?? 1, quality: "authoritative" },
          retries: { value: Math.max(0, claim.task.attempts.length - 1), quality: "authoritative" },
        }, true);
        if (decision.status === "paused" || decision.status === "blocked") throw new Error(decision.reason);
      }
      const [agents, capabilities, mcpConfigurations] = await Promise.all([
        this.agents.selected(conversation.selectedAgentIds, conversation.workingDirectory),
        this.capabilities.snapshot(conversation.workingDirectory),
        this.capabilities.mcpServerConfigurations(),
      ]);
      const selectedSkillPaths = capabilities.skills.filter((skill) => skill.enabled).map((skill) => skill.path);
      const preparedMcp = conversation.provider === "openrouter"
        ? await this.toolGateway.prepare(mcpConfigurations, this.state.settings.mcpToolPolicies ?? {})
        : { tools: [], results: [] };
      const prompt = [
        claim.task.description || claim.task.title,
        claim.checkpoint ? `Resume from checkpoint: ${claim.checkpoint.cursor}` : "",
        workspaceLease.kind === "git" && workspaceLease.writable ? "Work only in the assigned isolated worktree. Grokky will checkpoint completed changes into its task branch." : "",
      ].filter(Boolean).join("\n\n");
      await this.pauseTaskAtBoundary(claim, controller, workspaceLease);
      await this.recordTaskEvent(claim, "run.started", { prompt, workspaceLeaseId: workspaceLease.id, harnessId });
      await this.harnessRegistry.dispatch(conversation, {
        conversation,
        settings: structuredClone(this.state.settings),
        agents,
        prompt,
        signal: controller.signal,
        selectedSkillPaths,
        computerAccess: structuredClone(this.state.computerAccess),
        executeTool: async (name, args, options) => {
          await this.pauseTaskAtBoundary(claim, controller, workspaceLease);
          const output = await this.executeTaskComputerTool(claim, conversation, workspaceLease, name, args, options);
          await this.pauseTaskAtBoundary(claim, controller, workspaceLease);
          return output;
        },
        controlTask: (taskId, request) => this.controlTask(taskId, request),
        mcpTools: preparedMcp.tools,
        executeMcpTool: async (name, args, options) => {
          await this.pauseTaskAtBoundary(claim, controller, workspaceLease);
          const output = await this.executeMcpTool(source.id, mcpConfigurations, name, args, controller.signal, options?.readOnly === true);
          await this.pauseTaskAtBoundary(claim, controller, workspaceLease);
          return output;
        },
        onEvent: async (event) => {
          await this.pauseTaskAtBoundary(claim, controller, workspaceLease);
          if (event.type === "thread") {
            this.taskSessions.set(claim.task.id, event.threadId);
            if (assignment.agentId) await this.teamRuntime?.rememberSession(assignment.agentId, harnessId, event.threadId);
          } else if (event.type === "final") finalText = event.text;
          else if (event.type === "usage") {
            usage = event.usage;
            if (this.steering) {
              const quality = descriptor.capabilities.usage;
              const decision = await this.evaluateTaskBudget(claim.task.id, {
                tokens: quality === "unavailable" ? { quality } : { value: event.usage.inputTokens + event.usage.outputTokens + (event.usage.reasoningTokens ?? 0), quality },
                costUsd: event.usage.costUsd === undefined || quality === "unavailable" ? { quality: "unavailable" } : { value: event.usage.costUsd, quality },
                elapsedMs: { value: Date.now() - startedAt, quality: "authoritative" },
                concurrency: { value: this.taskScheduler?.snapshot().tasks.filter((task) => task.status === "leased" || task.status === "running").length ?? 1, quality: "authoritative" },
                retries: { value: Math.max(0, claim.task.attempts.length - 1), quality: "authoritative" },
              }, true);
              if (decision.status === "paused" || decision.status === "blocked") throw new Error(decision.reason);
            }
          }
          await this.recordTaskEvent(claim, this.taskEventType(event), this.taskEventPayload(event));
        },
      }, {
        streaming: true,
        cancellation: true,
        tools: true,
        ...this.taskRequiredCapabilities(assignment.requiredCapabilities),
      });
      await this.pauseTaskAtBoundary(claim, controller, workspaceLease);
      if (heartbeatFailure) throw heartbeatFailure;
      if (workspaceLease.kind === "git" && workspaceLease.writable) {
        const commit = await this.checkpointTaskWorkspace(workspaceLease, claim.task.title);
        if (commit) await this.taskScheduler?.checkpoint(claim.task.id, claim.lease.id, { cursor: `git:${commit}`, recoverable: true });
      }
      await this.recordTaskEvent(claim, "run.completed", { outcome: "delivered", ...(usage ? { usage } : {}) });
      return { summary: (finalText.trim() || `Completed ${claim.task.title}`).slice(0, 4_000) };
    } catch (error) {
      await this.recordTaskEvent(claim, controller.signal.aborted ? "run.stopped" : "run.failed", {
        error: error instanceof Error ? error.message : "Task execution failed",
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
      try {
        await this.workspaceLeases.complete(workspaceLease.id);
      } catch {
        // A reconciler may already have fenced the workspace lease after a host failure.
      }
      if (this.taskControllers.get(claim.task.id) === controller) this.taskControllers.delete(claim.task.id);
      this.taskSessions.delete(claim.task.id);
      this.pendingTaskPauses.delete(claim.task.id);
      this.publishSnapshot();
    }
  }

  private async pauseTaskAtBoundary(claim: TaskLeaseClaim, controller: AbortController, workspaceLease: WorkspaceLease): Promise<void> {
    if (this.pendingTaskPauses.get(claim.task.id) !== claim.lease.id) return;
    if (workspaceLease.kind === "git" && workspaceLease.writable) {
      try {
        const commit = await this.checkpointTaskWorkspace(workspaceLease);
        if (commit) await this.taskScheduler?.checkpoint(claim.task.id, claim.lease.id, { cursor: `git:${commit}`, recoverable: true });
      } catch (error) {
        await this.recordTaskEvent(claim, "diagnostic.recorded", { checkpoint: { status: "failed", error: error instanceof Error ? error.message : "Task checkpoint failed" } });
      }
    }
    this.pendingTaskPauses.delete(claim.task.id);
    controller.abort();
    await this.taskScheduler?.interrupt(claim.task.id, claim.lease.id, "paused");
    throw new TaskExecutionPausedError();
  }

  private resumeRemoteTasks(): void {
    if (!this.taskScheduler) return;
    for (const task of this.taskScheduler.snapshot().tasks) {
      if ((task.status !== "leased" && task.status !== "running") || !task.lease || !task.checkpoints.at(-1)?.cursor.startsWith("remote:")) continue;
      if (this.taskControllers.has(task.id)) continue;
      const claim: TaskLeaseClaim = { task, lease: task.lease, checkpoint: task.checkpoints.at(-1) };
      void this.executeTaskClaim(claim).catch(async (error) => {
        if (error instanceof TaskExecutionDetachedError) return;
        await this.notifications?.notify({ type: "remote-disconnect", title: "Remote task needs attention", body: error instanceof Error ? error.message : "Remote task monitoring failed", taskId: task.id });
      });
    }
  }

  private async executeRemoteTaskClaim(claim: TaskLeaseClaim, source: Conversation, harnessId: string, model: string): Promise<{ summary: string; settledExternally: true }> {
    if (!this.taskScheduler) throw new Error("The task scheduler is not available");
    const targetHostId = claim.task.assignment.targetHostId;
    if (!targetHostId) throw new Error("Remote task is missing its target host");
    const controller = new AbortController();
    this.taskControllers.set(claim.task.id, controller);
    const agent = claim.task.assignment.agentId
      ? (await this.agents.list(source.workingDirectory)).find((entry) => entry.id === claim.task.assignment.agentId)
      : undefined;
    const jobId = `job:${claim.lease.attemptId}`;
    const leaseEpoch = claim.task.attempts.find((attempt) => attempt.id === claim.lease.attemptId)?.number ?? claim.task.attempts.length;
    let client: HostClient;
    let cursor = this.remoteCheckpointCursor(claim.checkpoint?.cursor);
    try {
      const submitted = await this.computerAccess.submitRemoteJob(this.state.computerAccess, targetHostId, {
        id: jobId,
        idempotencyKey: claim.lease.idempotencyKey,
        taskId: claim.task.id,
        attemptId: claim.lease.attemptId,
        leaseEpoch,
        harnessId,
        payload: {
          prompt: [claim.task.description || claim.task.title, claim.checkpoint && !claim.checkpoint.cursor.startsWith("remote:") ? `Resume from checkpoint: ${claim.checkpoint.cursor}` : ""].filter(Boolean).join("\n\n"),
          model,
          reasoning: source.reasoning,
          sandboxMode: claim.task.assignment.workspaceMode === "read" ? "read-only" : source.sandboxMode,
          allowCommands: claim.task.assignment.workspaceMode !== "read" && source.allowCommands,
          ...(claim.task.assignment.screenKind ? { screenKind: claim.task.assignment.screenKind } : {}),
          ...(agent ? { agents: [agent] } : {}),
          ...this.remoteSessionPayload(claim.task.assignment.agentId, harnessId),
        },
        approvalPolicy: claim.task.assignment.approvalPolicy ?? "ask",
        budgetUsd: claim.task.assignment.budgetUsd ?? this.steering?.snapshot().budgetPolicy.hard.costUsd ?? 10,
      });
      client = submitted.client;
      this.remoteTaskClients.set(claim.task.id, { client, jobId, leaseEpoch, cursor });
      if (!claim.checkpoint?.cursor.startsWith("remote:")) {
        await this.taskScheduler.checkpoint(claim.task.id, claim.lease.id, { cursor: `remote:${JSON.stringify({ hostId: targetHostId, jobId, leaseEpoch })}`, recoverable: true });
      }
      await this.recordTaskEvent(claim, "diagnostic.recorded", { remote: { hostId: targetHostId, jobId, leaseEpoch, status: submitted.job.status } });
      let retryMs = 250;
      while (!controller.signal.aborted) {
        try {
          const frames = await this.computerAccess.remoteEvents(client, cursor);
          retryMs = 250;
          for (const frame of frames) {
            cursor = Math.max(cursor, frame.cursor);
            const active = this.remoteTaskClients.get(claim.task.id);
            if (active) active.cursor = cursor;
            if (frame.jobId !== jobId || frame.leaseEpoch !== leaseEpoch) continue;
            const terminal = await this.applyRemoteTaskFrame(claim, frame, harnessId);
            await this.taskScheduler.checkpointRemote(claim.task.id, claim.lease.attemptId, `remote:${JSON.stringify({ hostId: targetHostId, jobId, leaseEpoch, cursor })}`);
            if (terminal) {
              this.remoteTaskClients.delete(claim.task.id);
              if (terminal.status === "succeeded") {
                await this.taskScheduler.completeRemote(claim.task.id, claim.lease.attemptId, { summary: terminal.summary });
                return { summary: terminal.summary, settledExternally: true };
              }
              await this.taskScheduler.failRemote(claim.task.id, claim.lease.attemptId, terminal.summary);
              throw new Error(terminal.summary);
            }
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          if (error instanceof Error && /authorization|incompatible|signature|stale lease|invalid harness/i.test(error.message)) throw error;
          retryMs = Math.min(retryMs * 2, 5_000);
        }
        await this.waitForRemotePoll(retryMs, controller.signal);
      }
      throw new TaskExecutionDetachedError();
    } finally {
      if (this.taskControllers.get(claim.task.id) === controller) this.taskControllers.delete(claim.task.id);
      if (controller.signal.aborted) this.remoteTaskClients.delete(claim.task.id);
      this.publishSnapshot();
    }
  }

  private async applyRemoteTaskFrame(claim: TaskLeaseClaim, frame: RemoteEventFrame, harnessId: string): Promise<{ status: "succeeded" | "failed"; summary: string } | undefined> {
    if (frame.type === "job.output" && frame.payload && typeof frame.payload === "object" && "event" in frame.payload) {
      const event = validateHarnessEvent((frame.payload as { event: ProviderEvent }).event);
      if (event?.type === "thread" && claim.task.assignment.agentId) await this.teamRuntime?.rememberSession(claim.task.assignment.agentId, harnessId, event.threadId);
      if (event?.type) await this.recordRemoteTaskEvent(claim, frame, this.taskEventType(event), this.taskEventPayload(event));
    } else {
      await this.recordRemoteTaskEvent(claim, frame, "diagnostic.recorded", { remote: { cursor: frame.cursor, type: frame.type, payload: frame.payload } });
    }
    if (frame.type === "job.approval") await this.notifications?.notify({ type: "approval", title: "Remote task needs approval", body: `Task ${claim.task.title} is waiting on its paired host.`, taskId: claim.task.id });
    if (frame.type === "job.completed") return { status: "succeeded", summary: this.remoteSummary(frame.payload, `Completed ${claim.task.title}`) };
    if (frame.type === "job.failed" || frame.type === "job.canceled") return { status: "failed", summary: this.remoteSummary(frame.payload, `Remote task ${frame.type === "job.canceled" ? "was canceled" : "failed"}`) };
    return undefined;
  }

  private remoteSummary(payload: unknown, fallback: string): string {
    if (payload && typeof payload === "object") {
      const value = "output" in payload ? (payload as { output?: unknown }).output : "error" in payload ? (payload as { error?: unknown }).error : undefined;
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 4_000);
    }
    return fallback;
  }

  private remoteSessionPayload(agentId: string | undefined, harnessId: string): { threadId?: string } {
    if (!agentId) return {};
    const threadId = this.teamRuntime?.snapshot().agents.find((entry) => entry.id === agentId)?.sessionReferences[harnessId];
    return threadId ? { threadId } : {};
  }

  private remoteCheckpointCursor(value: string | undefined): number {
    if (!value?.startsWith("remote:")) return 0;
    try { const parsed = JSON.parse(value.slice("remote:".length)) as { cursor?: unknown }; return Number.isSafeInteger(parsed.cursor) && Number(parsed.cursor) >= 0 ? Number(parsed.cursor) : 0; }
    catch { return 0; }
  }

  private async recordRemoteTaskEvent(claim: TaskLeaseClaim, frame: RemoteEventFrame, type: ControlPlaneEventType, payload: unknown): Promise<void> {
    if (!this.controlPlane) return;
    await this.controlPlane.record({ id: `remote:${frame.jobId}:${frame.cursor}`, aggregateId: claim.task.id, taskId: claim.task.id, attemptId: claim.lease.attemptId, source: "grokky.remote-host", type, payload, timestamp: frame.timestamp });
  }

  private waitForRemotePoll(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolvePromise) => {
      if (signal.aborted) { resolvePromise(); return; }
      const timer = setTimeout(done, delayMs);
      function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolvePromise(); }
      signal.addEventListener("abort", done, { once: true });
    });
  }

  private async checkpointTaskWorkspace(lease: WorkspaceLease, title = "safe-boundary checkpoint"): Promise<string | undefined> {
    const repository = await GitRepository.open(lease.root);
    if (!await repository.status(lease.root)) return undefined;
    await repository.git(["add", "--all", "--"], { cwd: lease.root });
    await repository.git([
      "-c", "user.name=Grokky Agent",
      "-c", "user.email=grokky-agent@localhost",
      "commit", "-m", `task: ${title.replace(/\s+/g, " ").trim().slice(0, 160) || "completed work"}`,
      "--no-verify",
    ], { cwd: lease.root });
    return repository.head(lease.root);
  }

  private async executeTaskComputerTool(
    claim: TaskLeaseClaim,
    conversation: Conversation,
    workspaceLease: WorkspaceLease,
    name: ComputerToolName,
    args: Record<string, unknown>,
    options?: { readOnly?: boolean },
  ): Promise<string> {
    const scoped = options?.readOnly ? { ...conversation, sandboxMode: "read-only" as const, allowCommands: false } : conversation;
    const capability = capabilityForTool(name);
    const target = targetForTool(name, args);
    const approvedTarget = await this.authorizeComputerTool(scoped, capability, name, target);
    try {
      const output = await this.computerAccess.execute({ state: this.state.computerAccess, conversation: scoped, name, args, approvedTarget, workspaceLease });
      const audit = this.appendComputerAudit(scoped, capability, name, target, "allowed", "completed", output.slice(0, 2_000));
      await this.recordTaskEvent(claim, "audit.recorded", { audit });
      await this.commit();
      return output;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Computer action failed";
      const audit = this.appendComputerAudit(scoped, capability, name, target, "allowed", "failed", detail);
      await this.recordTaskEvent(claim, "audit.recorded", { audit });
      await this.commit();
      throw error;
    }
  }

  private taskRequiredCapabilities(values: string[] | undefined): RequiredHarnessCapabilities {
    const required: RequiredHarnessCapabilities = {};
    for (const value of values ?? []) {
      if (value === "steering" || value === "steering:follow-up") required.steering = "follow-up";
      else if (value === "steering:mid-turn") required.steering = "mid-turn";
      else if (value === "usage") required.usage = "estimated";
      else if (new Set(["sessionPersistence", "streaming", "cancellation", "tools", "mcp", "computerControl", "multiAgent"]).has(value)) {
        (required as Record<string, unknown>)[value] = true;
      } else throw new Error(`Unsupported task harness capability: ${value}`);
    }
    return required;
  }

  private taskEventType(event: ProviderEvent): ControlPlaneEventType {
    if (event.type === "thread") return "provider.thread";
    if (event.type === "activity") return "provider.activity";
    if (event.type === "orchestration") return "orchestration.updated";
    if (event.type === "usage") return "usage.updated";
    return "run.final";
  }

  private taskEventPayload(event: ProviderEvent): unknown {
    if (event.type === "thread") return { threadId: event.threadId };
    if (event.type === "activity") return { activity: event.activity };
    if (event.type === "orchestration") return { event: event.event };
    if (event.type === "usage") return { usage: event.usage };
    return { message: { id: id(), role: "assistant", content: event.text, createdAt: Date.now() } };
  }

  private async recordTaskEvent(claim: TaskLeaseClaim, type: ControlPlaneEventType, payload: unknown): Promise<void> {
    if (!this.controlPlane) return;
    await this.controlPlane.record({
      aggregateId: claim.task.id,
      taskId: claim.task.id,
      attemptId: claim.lease.attemptId,
      source: "grokky.task-dispatcher",
      type,
      payload,
    });
  }

  private async executeRun(conversationId: string, prompt: string, controller: AbortController): Promise<void> {
    const original = this.requireConversation(conversationId);
    const conversation = structuredClone(original);
    const settings = structuredClone(this.state.settings);
    const computerAccess = structuredClone(this.state.computerAccess);
    const onEvent = (event: ProviderEvent) => this.applyProviderEvent(conversationId, event);
    const executeTool = (name: ComputerToolName, args: Record<string, unknown>, options?: { readOnly?: boolean }) => this.executeComputerTool(conversationId, name, args, options);
    const controlTask = (taskId: string, request: TaskControlRequest) => this.controlTask(taskId, request);
    try {
      const [agents, capabilities, mcpConfigurations] = await Promise.all([
        this.agents.selected(conversation.selectedAgentIds, conversation.workingDirectory),
        this.capabilities.snapshot(conversation.workingDirectory),
        this.capabilities.mcpServerConfigurations(),
      ]);
      const selectedSkillPaths = capabilities.skills.filter((skill) => skill.enabled).map((skill) => skill.path);
      const preparedMcp = conversation.provider === "openrouter"
        ? await this.toolGateway.prepare(mcpConfigurations, settings.mcpToolPolicies ?? {})
        : { tools: [], results: [] };
      const executeMcpTool = (name: string, args: Record<string, unknown>, options?: { readOnly?: boolean }) => this.executeMcpTool(
        conversationId,
        mcpConfigurations,
        name,
        args,
        controller.signal,
        options?.readOnly === true,
      );
      this.runAgentIcons.set(conversationId, new Map(agents.flatMap((agent) => agent.icon ? [[agent.name.toLowerCase(), agent.icon] as const] : [])));
      await this.harnessRegistry.dispatch(
        conversation,
        { conversation, settings, agents, prompt, signal: controller.signal, selectedSkillPaths, computerAccess, executeTool, controlTask, mcpTools: preparedMcp.tools, executeMcpTool, onEvent },
        this.requiredHarnessCapabilities(conversation),
      );
      const current = this.state.conversations.find((item) => item.id === conversationId);
      if (current && this.runs.get(conversationId) === controller) {
        current.status = "idle";
        current.lastRunOutcome = classifyRunOutcome(current, conversation.selectedAgentIds.length);
        current.error = undefined;
        current.updatedAt = Date.now();
        this.finishHarnessAttempt(current, this.runIds.get(conversationId), "completed");
        await this.recordConversationEvent(current, "run.completed", { outcome: current.lastRunOutcome }, this.runIds.get(conversationId));
        await this.commit();
      }
    } catch (error) {
      const current = this.state.conversations.find((item) => item.id === conversationId);
      if (current && this.runs.get(conversationId) === controller) {
        current.status = "error";
        current.lastRunOutcome = controller.signal.aborted ? "stopped" : "failed";
        current.error = controller.signal.aborted ? "Run stopped" : error instanceof Error ? error.message : "Provider run failed";
        current.updatedAt = Date.now();
        this.finishHarnessAttempt(current, this.runIds.get(conversationId), controller.signal.aborted ? "stopped" : "failed");
        await this.recordConversationEvent(
          current,
          controller.signal.aborted ? "run.stopped" : "run.failed",
          controller.signal.aborted ? { reason: "aborted" } : { error: current.error },
          this.runIds.get(conversationId),
        );
        await this.commit();
      }
    } finally {
      if (this.runs.get(conversationId) === controller) this.runs.delete(conversationId);
      this.runIds.delete(conversationId);
      this.runAgentIcons.delete(conversationId);
    }
  }

  private async applyProviderEvent(conversationId: string, event: ProviderEvent): Promise<void> {
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    let eventType: ControlPlaneEventType;
    let eventPayload: unknown;
    if (event.type === "thread") {
      conversation.threadId = event.threadId;
      const attempt = this.currentHarnessAttempt(conversation, this.runIds.get(conversationId));
      if (attempt) attempt.session = {
        harnessId: attempt.harnessId,
        adapterVersion: attempt.adapterVersion,
        nativeSessionId: event.threadId,
      };
    }
    if (event.type === "usage") conversation.usage = event.usage;
    if (event.type === "final") {
      const message: ChatMessage = {
        id: id(),
        role: "assistant",
        content: event.text,
        createdAt: Date.now(),
        provider: conversation.provider,
      };
      conversation.messages.push(message);
      eventType = "run.final";
      eventPayload = { message };
    }
    if (event.type === "activity") {
      const index = conversation.activities.findIndex((item) => item.id === event.activity.id);
      if (index >= 0) conversation.activities[index] = { ...event.activity, createdAt: conversation.activities[index]!.createdAt };
      else conversation.activities.push(event.activity);
      conversation.activities = conversation.activities.slice(-80);
    }
    if (event.type === "orchestration") {
      const now = Date.now();
      const stateStatus = (value: string): AgentRunStatus => {
        if (/complete|done/i.test(value)) return "completed";
        if (/fail|error|not_found/i.test(value)) return "failed";
        if (/stop|shutdown|close|interrupt/i.test(value)) return "stopped";
        if (/wait/i.test(value)) return "waiting";
        if (/pending|init|start/i.test(value)) return "starting";
        return "working";
      };
      const iconFor = (name: string | undefined): AgentIcon | undefined => name ? this.runAgentIcons.get(conversationId)?.get(name.toLowerCase()) : undefined;
      if (event.event.tool === "spawn_agent" && event.event.status === "running" && !event.event.receiverThreads.length) {
        const pendingId = `pending:${event.event.operationId}`;
        if (!conversation.agentRuns.some((run) => run.id === pendingId)) {
          conversation.agentRuns.push({
            id: pendingId,
            operationId: event.event.operationId,
            threadId: pendingId,
            name: "Starting agent",
            task: event.event.prompt || "Preparing delegated work",
            status: "starting",
            createdAt: now,
            updatedAt: now,
          });
        }
      } else {
        if (event.event.tool === "spawn_agent" && event.event.receiverThreads.length) {
          conversation.agentRuns = conversation.agentRuns.filter((run) => run.id !== `pending:${event.event.operationId}`);
        }
        for (const thread of event.event.receiverThreads) {
          const icon = iconFor(thread.name);
          const index = conversation.agentRuns.findIndex((run) => run.threadId === thread.threadId);
          const status = event.event.tool === "wait" && event.event.status === "running" ? "waiting" : stateStatus(thread.status);
          if (index >= 0) {
            const previous = conversation.agentRuns[index]!;
            conversation.agentRuns[index] = {
              ...previous,
              status,
              ...(thread.name ? { name: thread.name } : {}),
              ...(icon ? { icon } : {}),
              ...(event.event.prompt && event.event.tool !== "wait" ? { task: event.event.prompt } : {}),
              ...(thread.message ? { result: thread.message } : {}),
              updatedAt: now,
            };
          } else {
            conversation.agentRuns.push({
              id: thread.threadId,
              operationId: event.event.operationId,
              threadId: thread.threadId,
              name: thread.name || `Crew member ${conversation.agentRuns.length + 1}`,
              ...(icon ? { icon } : {}),
              task: event.event.prompt || "Delegated task",
              status,
              ...(thread.message ? { result: thread.message } : {}),
              createdAt: now,
              updatedAt: now,
            });
          }
        }
      }
      conversation.agentRuns = conversation.agentRuns.slice(-40);
      conversation.crewCommunications = mergeCrewCommunications(
        conversation.crewCommunications,
        communicationsFromOrchestrationEvent(event.event, conversation.agentRuns, now),
      );
    }
    conversation.updatedAt = Date.now();
    if (event.type === "thread") {
      eventType = "provider.thread";
      eventPayload = { threadId: event.threadId };
    } else if (event.type === "usage") {
      eventType = "usage.updated";
      eventPayload = { usage: event.usage };
    } else if (event.type === "activity") {
      eventType = "provider.activity";
      eventPayload = { activity: event.activity };
    } else if (event.type === "orchestration") {
      eventType = "orchestration.updated";
      eventPayload = { event: event.event, icons: Object.fromEntries(this.runAgentIcons.get(conversationId) ?? []) };
    }
    await this.recordConversationEvent(conversation, eventType!, eventPayload, this.runIds.get(conversationId));
    await this.commit();
  }

  private requireConversation(conversationId: string): Conversation {
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (!conversation) throw new Error("Conversation not found");
    return conversation;
  }

  private async executeComputerTool(conversationId: string, name: ComputerToolName, args: Record<string, unknown>, options?: { readOnly?: boolean }): Promise<string> {
    const source = this.requireConversation(conversationId);
    const conversation = options?.readOnly ? { ...source, sandboxMode: "read-only" as const, allowCommands: false } : source;
    const capability = capabilityForTool(name);
    const target = targetForTool(name, args);
    const approvedTarget = await this.authorizeComputerTool(conversation, capability, name, target);
    try {
      const output = await this.computerAccess.execute({ state: this.state.computerAccess, conversation, name, args, approvedTarget });
      const audit = this.appendComputerAudit(conversation, capability, name, target, "allowed", "completed", output.slice(0, 2_000));
      await this.recordAuditEvent(conversation, audit);
      await this.commit();
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Computer action failed";
      const audit = this.appendComputerAudit(conversation, capability, name, target, "allowed", "failed", message);
      await this.recordAuditEvent(conversation, audit);
      await this.commit();
      throw error;
    }
  }

  private async executeMcpTool(
    conversationId: string,
    configurations: Awaited<ReturnType<CapabilitiesService["mcpServerConfigurations"]>>,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    readOnly: boolean,
  ): Promise<string> {
    const conversation = this.requireConversation(conversationId);
    let authorizedTool: HarnessMcpTool | undefined;
    let authorizationAttempted = false;
    let authorized = false;
    try {
      const output = await this.toolGateway.execute({
        configurations,
        policies: this.state.settings.mcpToolPolicies ?? {},
        name,
        args,
        readOnly,
        signal,
        authorize: async (tool) => {
          authorizedTool = tool;
          authorizationAttempted = true;
          await this.authorizeComputerTool(conversation, "mcp", `mcp_${tool.classification}`, `${tool.serverId}/${tool.originalName}`);
          authorized = true;
        },
      });
      const target = authorizedTool ? `${authorizedTool.serverId}/${authorizedTool.originalName}` : name;
      const audit = this.appendComputerAudit(conversation, "mcp", name, target, "allowed", "completed", `MCP tool completed (${output.length} characters returned).`);
      await this.recordAuditEvent(conversation, audit);
      await this.commit();
      return output;
    } catch (error) {
      const message = error instanceof Error && /authorization|cancelled|timed out|disconnected|restricted|read-only|unavailable/i.test(error.message)
        ? error.message.slice(0, 300)
        : "MCP tool failed without persisting server-provided error content.";
      if (authorizationAttempted && !authorized) throw error;
      const target = authorizedTool ? `${authorizedTool.serverId}/${authorizedTool.originalName}` : name;
      const audit = this.appendComputerAudit(conversation, "mcp", name, target, authorized ? "allowed" : "denied", "failed", message);
      await this.recordAuditEvent(conversation, audit);
      await this.commit();
      throw error;
    }
  }

  private async authorizeComputerTool(conversation: Conversation, capability: ComputerCapabilityId, action: string, target: string): Promise<boolean> {
    const access = this.state.computerAccess;
    if (!access.enabled || access.grants[capability] === "blocked") {
      const audit = this.appendComputerAudit(conversation, capability, action, target, "denied", "failed", access.enabled ? "Capability is blocked" : "Computer access is disabled");
      await this.recordAuditEvent(conversation, audit);
      await this.commit();
      throw new Error(access.enabled ? `${capability} access is blocked` : "Computer access is disabled");
    }
    if (access.grants[capability] === "allow") return false;
    if (this.sessionComputerGrants.get(conversation.id)?.has(capability)) return true;
    const device = this.computerAccess.snapshot(access, conversation.workingDirectory).devices.find((item) => item.id === access.activeDeviceId);
    const approval: ComputerApprovalRequest = {
      id: `approval-${id()}`,
      deviceId: capability === "mcp" ? access.localDeviceId : access.activeDeviceId,
      deviceName: capability === "mcp" ? "Grokky MCP gateway" : device?.name || "Computer",
      conversationId: conversation.id,
      capability,
      action: action.replaceAll("_", " "),
      target,
      createdAt: Date.now(),
    };
    this.pendingApprovals.push(approval);
    await this.recordConversationEvent(conversation, "approval.requested", { approval }, this.runIds.get(conversation.id));
    this.publishSnapshot();
    const decision = await new Promise<ComputerApprovalDecision>((resolve) => this.approvalResolvers.set(approval.id, resolve));
    if (decision === "deny") {
      const audit = this.appendComputerAudit(conversation, capability, action, target, "denied", "failed", "User denied the computer action");
      await this.recordAuditEvent(conversation, audit);
      await this.commit();
      throw new Error("Computer action was denied");
    }
    return true;
  }

  private appendComputerAudit(
    conversation: Conversation,
    capability: ComputerCapabilityId,
    action: string,
    target: string,
    decision: "allowed" | "denied",
    status: "completed" | "failed",
    detail?: string,
  ): ComputerAuditEntry {
    const audit: ComputerAuditEntry = {
      id: newAuditId(),
      deviceId: capability === "mcp" ? this.state.computerAccess.localDeviceId : this.state.computerAccess.activeDeviceId,
      conversationId: conversation.id,
      provider: conversation.provider,
      capability,
      action,
      target,
      decision,
      status,
      ...(detail ? { detail } : {}),
      createdAt: Date.now(),
    };
    this.state.computerAccess.auditLog.push(audit);
    this.state.computerAccess.auditLog = this.state.computerAccess.auditLog.slice(-250);
    return audit;
  }

  private denyPendingApprovals(conversationId: string): void {
    for (const approval of [...this.pendingApprovals]) {
      if (approval.conversationId !== conversationId) continue;
      const index = this.pendingApprovals.findIndex((item) => item.id === approval.id);
      if (index >= 0) this.pendingApprovals.splice(index, 1);
      this.approvalResolvers.get(approval.id)?.("deny");
      this.approvalResolvers.delete(approval.id);
    }
  }

  private activeWorkingDirectory(): string {
    return this.state.conversations.find((item) => item.id === this.state.activeConversationId)?.workingDirectory
      || this.state.settings.defaultWorkingDirectory
      || this.homeDirectory;
  }

  private async requireRemoteMcpConfiguration(serverId: string) {
    if (!/^[a-zA-Z0-9_@./-]{1,240}$/.test(serverId)) throw new Error("Invalid MCP server ID");
    const configuration = (await this.capabilities.mcpServerConfigurations()).find((server) => server.id === serverId && server.enabled);
    if (!configuration || configuration.transport !== "streamable-http" || !configuration.url) throw new Error("Enabled remote MCP server was not found");
    return configuration;
  }

  private rememberProject(pathname: string): void {
    const normalized = resolve(pathname);
    const recents = this.state.settings.recentWorkingDirectories.filter((item) => resolve(item) !== normalized);
    this.state.settings.recentWorkingDirectories = [pathname, ...recents].slice(0, 12);
    this.state.settings.defaultWorkingDirectory = pathname;
  }

  private async recordConversationEvent(
    conversation: Conversation,
    type: ControlPlaneEventType,
    payload: unknown,
    runId?: string,
  ): Promise<void> {
    if (!this.controlPlane) return;
    await this.controlPlane.record({
      aggregateId: conversation.id,
      conversationId: conversation.id,
      ...(runId ? { runId } : {}),
      source: "grokky.controller",
      type,
      payload,
    });
  }

  private recordAuditEvent(conversation: Conversation, audit: ComputerAuditEntry): Promise<void> {
    return this.recordConversationEvent(conversation, "audit.recorded", { audit }, this.runIds.get(conversation.id));
  }

  private requiredHarnessCapabilities(conversation: Conversation): RequiredHarnessCapabilities {
    return {
      streaming: true,
      cancellation: true,
      tools: true,
      ...(conversation.selectedAgentIds.length ? { multiAgent: true } : {}),
    };
  }

  private currentHarnessAttempt(conversation: Conversation, attemptId?: string): HarnessAttempt | undefined {
    if (!attemptId) return undefined;
    return conversation.harnessAttempts?.findLast((attempt) => attempt.id === attemptId);
  }

  private finishHarnessAttempt(
    conversation: Conversation,
    attemptId: string | undefined,
    status: Exclude<HarnessAttempt["status"], "running">,
  ): void {
    const attempt = this.currentHarnessAttempt(conversation, attemptId);
    if (!attempt || attempt.status !== "running") return;
    attempt.status = status;
    attempt.endedAt = Date.now();
  }

  private async commit(): Promise<void> {
    await this.store.save(this.state);
    this.publishSnapshot();
  }

  private publishSnapshot(): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(IPC.snapshotChanged, this.snapshot());
  }
}
