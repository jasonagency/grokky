import type { ControlPolicyPatch, ControlRuntimeSnapshot, EvalComparisonResult, EvalMetricSet, EvalStateSnapshot, EvalVerificationRule, ProjectionChange, ReplayRequest, ReplayResult, TaskAction, TaskControlRequest, TaskGoalDraft, TaskGraphSnapshot, TraceBundle, TraceQuery, WorkspaceStateSnapshot } from "./control-plane-contracts";
import type { HarnessAttempt, HarnessRegistryEntry } from "./harness-contracts";
import type { AgentScreenSnapshot } from "./remote-protocol";

export type ProviderId = "codex" | "openrouter" | "pi";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type SandboxMode = "read-only" | "workspace-write";
export type RunStatus = "idle" | "running" | "error";
export type RunOutcome = "delivered" | "blocked" | "failed" | "stopped";
export type ProjectMode = "project" | "none";
export type AgentScope = "built-in" | "personal" | "project";
export type AgentRunStatus = "starting" | "working" | "waiting" | "completed" | "failed" | "stopped";
export type AgentIcon = "lime" | "cyan" | "coral" | "violet" | "amber" | "mint";
export type AccentPalette = "lime" | "electric-blue" | "ultraviolet" | "solar-amber" | "ice";
export type ComputerCapabilityId = "files" | "commands" | "browser" | "screen" | "automation" | "mcp";
export type ComputerAccessLevel = "blocked" | "ask" | "allow";
export type ComputerPermissionStatus = "granted" | "denied" | "not-determined" | "not-required" | "unavailable";
export type ComputerDeviceStatus = "online" | "offline" | "revoked";
export type ComputerApprovalDecision = "deny" | "allow-once" | "allow-session";

export interface UsageSummary {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  costUsd?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  provider: ProviderId;
}

export interface ActivityItem {
  id: string;
  kind: "reasoning" | "command" | "files" | "tool" | "plan" | "notice" | "agent";
  label: string;
  detail?: string;
  status: "running" | "completed" | "failed";
  createdAt: number;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  developerInstructions: string;
  scope: AgentScope;
  builtIn: boolean;
  icon?: AgentIcon;
  model?: string;
  reasoning?: ReasoningEffort;
  sandboxMode?: SandboxMode;
  path?: string;
}

export interface AgentDraft {
  name: string;
  description: string;
  developerInstructions: string;
  scope: Exclude<AgentScope, "built-in">;
  icon?: AgentIcon;
  model?: string;
  reasoning?: ReasoningEffort;
  sandboxMode?: SandboxMode;
}

export type PersistentAgentStatus = "active" | "hidden" | "archived" | "deleted";

export interface PersistentAgentRuntime {
  id: string;
  profile: AgentDefinition;
  profileHash: string;
  status: PersistentAgentStatus;
  pinned: boolean;
  harnessPreference?: string;
  sessionReferences: Record<string, string>;
  mailboxCursor?: string;
  notificationPolicy: "all" | "attention" | "none";
  createdAt: number;
  updatedAt: number;
}

export interface AgentMailboxMessage {
  id: string;
  threadId: string;
  senderId: string;
  receiverIds: string[];
  taskId?: string;
  kind: "direct" | "group" | "handoff";
  content: string;
  acknowledgedBy: string[];
  handoff?: { fromAgentId: string; toAgentId: string; acceptedAt?: number };
  createdAt: number;
}

export interface AgentMemory {
  id: string;
  agentId: string;
  kind: "fact" | "preference" | "summary";
  content: string;
  sourceReferences: string[];
  reviewStatus: "proposed" | "reviewed" | "rejected";
  createdAt: number;
  reviewedAt?: number;
}

export interface AgentRoutine {
  id: string;
  ownerAgentId: string;
  name: string;
  version: number;
  template: TaskGoalDraft;
  schedule: { localTime: string; timeZone: string; daysOfWeek?: number[] };
  targetHostId: string;
  policyId?: string;
  budgetUsd: number;
  approvalBoundary: "always" | "external-side-effects" | "never";
  active: boolean;
  nextFireAt: number;
  lastOccurrenceKey?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamStateSnapshot {
  revision: number;
  agents: PersistentAgentRuntime[];
  messages: AgentMailboxMessage[];
  memories: AgentMemory[];
  routines: AgentRoutine[];
}

export interface AgentRun {
  id: string;
  operationId: string;
  threadId: string;
  name: string;
  task: string;
  status: AgentRunStatus;
  icon?: AgentIcon;
  result?: string;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestrationThreadState {
  threadId: string;
  name?: string;
  status: string;
  message?: string;
}

export interface OrchestrationEvent {
  operationId: string;
  tool: string;
  senderThreadId: string;
  senderName?: string;
  receiverThreads: OrchestrationThreadState[];
  prompt?: string;
  status: "running" | "completed" | "failed";
}

export type CrewCommunicationKind = "assignment" | "message" | "report" | "status";

export interface CrewCommunication {
  id: string;
  operationId: string;
  tool: string;
  kind: CrewCommunicationKind;
  senderThreadId: string;
  senderName: string;
  receiverThreadId: string;
  receiverName: string;
  content?: string;
  status: "running" | "completed" | "failed";
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  provider: ProviderId;
  harnessId?: string;
  model: string;
  reasoning: ReasoningEffort;
  sandboxMode: SandboxMode;
  allowCommands: boolean;
  projectMode: ProjectMode;
  workingDirectory: string;
  threadId?: string;
  messages: ChatMessage[];
  activities: ActivityItem[];
  selectedAgentIds: string[];
  agentRuns: AgentRun[];
  crewCommunications: CrewCommunication[];
  harnessAttempts?: HarnessAttempt[];
  usage?: UsageSummary;
  status: RunStatus;
  lastRunOutcome?: RunOutcome;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AppSettings {
  defaultWorkingDirectory: string;
  recentWorkingDirectories: string[];
  openRouterCredentialPath: string;
  theme: "system" | "light" | "dark";
  updateChannel?: UpdateChannel;
  accentPalette?: AccentPalette;
  multiAgentEnabled: boolean;
  maxAgentThreads: number;
  defaultSubagentModel: string;
  defaultSubagentReasoning: ReasoningEffort | "";
  interruptAgentMessage: boolean;
  connectorsEnabled: boolean;
  webSearchEnabled: boolean;
  mcpToolPolicies?: Record<string, McpToolClassification>;
}

export interface ComputerCapability {
  id: ComputerCapabilityId;
  label: string;
  description: string;
  level: ComputerAccessLevel;
  permission: ComputerPermissionStatus;
  available: boolean;
}

export interface ComputerDevice {
  id: string;
  name: string;
  platform: string;
  kind: "local" | "remote";
  status: ComputerDeviceStatus;
  root: string;
  endpoint?: string;
  capabilities: ComputerCapabilityId[];
  lastSeenAt: number;
}

export interface ComputerAuditEntry {
  id: string;
  deviceId: string;
  conversationId?: string;
  provider?: ProviderId;
  capability: ComputerCapabilityId;
  action: string;
  target: string;
  decision: "allowed" | "denied";
  status: "completed" | "failed";
  detail?: string;
  createdAt: number;
}

export interface ComputerApprovalRequest {
  id: string;
  deviceId: string;
  deviceName: string;
  conversationId: string;
  capability: ComputerCapabilityId;
  action: string;
  target: string;
  createdAt: number;
}

export interface ComputerAccessSnapshot {
  enabled: boolean;
  activeDeviceId: string;
  devices: ComputerDevice[];
  capabilities: ComputerCapability[];
  networkAllowlist: string[];
  auditLog: ComputerAuditEntry[];
  pendingApproval?: ComputerApprovalRequest;
  screens?: AgentScreenSnapshot;
}

export interface SkillCapability {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: "project" | "personal" | "plugin" | "system";
  enabled: boolean;
}

export interface McpCapability {
  id: string;
  name: string;
  transport: "local" | "remote" | "configured";
  enabled: boolean;
  tools?: McpToolCapability[];
  status?: "idle" | "ready" | "authorization-required" | "error";
  detail?: string;
}

export type McpToolClassification = "read" | "write" | "external-side-effect" | "human-only";

export interface McpToolCapability {
  name: string;
  namespacedName: string;
  description: string;
  classification: McpToolClassification;
  classificationSource: "operator" | "server-annotation" | "safe-default";
}

export interface ConnectorCapability {
  id: string;
  name: string;
  enabled: boolean;
}

export interface CapabilitiesSnapshot {
  skills: SkillCapability[];
  mcpServers: McpCapability[];
  connectors: ConnectorCapability[];
  configPath: string;
}

export interface ProviderStatus {
  id: ProviderId;
  ready: boolean;
  label: string;
  source: string;
  detail: string;
}

export type UpdateChannel = "stable" | "beta";
export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "downloaded" | "blocked" | "error";

export interface UpdateFileInfo {
  url: string;
  sha512: string;
  size?: number;
}

export interface UpdateReleaseInfo {
  version: string;
  channel: UpdateChannel;
  releaseName?: string;
  releaseNotes?: string;
  releaseUrl?: string;
  publishedAt?: string;
  files: UpdateFileInfo[];
}

export interface UpdateSnapshot {
  status: UpdateStatus;
  channel: UpdateChannel;
  info?: UpdateReleaseInfo;
  progress?: { percent: number; transferred: number; total: number };
  blockers: string[];
  error?: string;
}

export interface AppSnapshot {
  conversations: Conversation[];
  activeConversationId?: string;
  settings: AppSettings;
  providerStatuses: ProviderStatus[];
  harnesses: HarnessRegistryEntry[];
  computerAccess: ComputerAccessSnapshot;
  taskGraph: TaskGraphSnapshot;
  workspaceState?: WorkspaceStateSnapshot;
  controlRuntime?: ControlRuntimeSnapshot;
  team?: TeamStateSnapshot;
  update?: UpdateSnapshot;
  appVersion: string;
}

export interface ConversationPatch {
  provider?: ProviderId;
  model?: string;
  reasoning?: ReasoningEffort;
  sandboxMode?: SandboxMode;
  allowCommands?: boolean;
  projectMode?: ProjectMode;
  workingDirectory?: string;
  selectedAgentIds?: string[];
}

export interface GrokkyApi {
  getSnapshot(): Promise<AppSnapshot>;
  createConversation(): Promise<string>;
  setActiveConversation(conversationId: string): Promise<void>;
  updateConversation(conversationId: string, patch: ConversationPatch): Promise<void>;
  deleteConversation(conversationId: string): Promise<void>;
  sendMessage(conversationId: string, text: string): Promise<void>;
  cancelRun(conversationId: string): Promise<void>;
  chooseWorkingDirectory(conversationId: string): Promise<string | null>;
  chooseOpenRouterCredential(): Promise<string | null>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  refreshProviderStatuses(): Promise<void>;
  getCapabilities(): Promise<CapabilitiesSnapshot>;
  refreshMcpCapabilities(): Promise<CapabilitiesSnapshot>;
  setSkillEnabled(path: string, enabled: boolean): Promise<CapabilitiesSnapshot>;
  setMcpEnabled(id: string, enabled: boolean): Promise<CapabilitiesSnapshot>;
  setMcpToolClassification(name: string, classification: McpToolClassification): Promise<CapabilitiesSnapshot>;
  beginMcpAuthorization(id: string): Promise<string>;
  completeMcpAuthorization(id: string, code: string): Promise<CapabilitiesSnapshot>;
  revokeMcpAuthorization(id: string): Promise<CapabilitiesSnapshot>;
  setConnectorEnabled(id: string, enabled: boolean): Promise<CapabilitiesSnapshot>;
  getAgents(): Promise<AgentDefinition[]>;
  createAgent(draft: AgentDraft): Promise<AgentDefinition[]>;
  updateAgent(id: string, draft: AgentDraft): Promise<AgentDefinition[]>;
  deleteAgent(id: string): Promise<AgentDefinition[]>;
  sendAgentMessage(input: Omit<AgentMailboxMessage, "id" | "acknowledgedBy" | "createdAt">): Promise<AgentMailboxMessage>;
  acknowledgeAgentMessage(messageId: string, agentId: string): Promise<AgentMailboxMessage>;
  proposeAgentMemory(input: Pick<AgentMemory, "agentId" | "kind" | "content" | "sourceReferences">): Promise<AgentMemory>;
  reviewAgentMemory(id: string, decision: "reviewed" | "rejected"): Promise<AgentMemory>;
  createAgentRoutine(input: Omit<AgentRoutine, "id" | "version" | "nextFireAt" | "lastOccurrenceKey" | "createdAt" | "updatedAt">): Promise<AgentRoutine>;
  updatePersistentAgent(agentId: string, action: "pin" | "unpin" | "hide" | "archive" | "restore" | "delete"): Promise<TeamStateSnapshot>;
  duplicatePersistentAgent(agentId: string, name: string): Promise<TeamStateSnapshot>;
  setComputerAccessEnabled(enabled: boolean): Promise<void>;
  setComputerCapability(id: ComputerCapabilityId, level: ComputerAccessLevel): Promise<void>;
  requestComputerPermission(id: ComputerCapabilityId): Promise<void>;
  testComputerCapability(id: ComputerCapabilityId): Promise<void>;
  pairComputer(endpoint: string, code: string): Promise<void>;
  selectComputer(deviceId: string): Promise<void>;
  revokeComputer(deviceId: string): Promise<void>;
  updateComputerNetworkAllowlist(domains: string[]): Promise<void>;
  resolveComputerApproval(id: string, decision: ComputerApprovalDecision): Promise<void>;
  takeoverScreen(leaseId: string, epoch: number): Promise<void>;
  returnScreen(leaseId: string, epoch: number): Promise<void>;
  lockScreen(leaseId: string, epoch: number): Promise<void>;
  createTaskGoal(draft: TaskGoalDraft): Promise<void>;
  actOnTask(taskId: string, action: TaskAction): Promise<void>;
  integrateTaskWorkspace(leaseId: string, targetRef: string): Promise<void>;
  controlTask(taskId: string, control: TaskControlRequest): Promise<void>;
  updateControlPolicies(patch: ControlPolicyPatch): Promise<void>;
  queryTrace(query: TraceQuery): Promise<TraceBundle>;
  replayTrace(request: ReplayRequest): Promise<ReplayResult>;
  getEvaluations(): Promise<EvalStateSnapshot>;
  promoteEvaluation(input: { id: string; name: string; trace: TraceBundle; expectedOutcome: string; allowedSideEffects?: string[]; verificationRules: EvalVerificationRule[] }): Promise<EvalStateSnapshot>;
  gradeEvaluation(caseId: string, version: number, trace: TraceBundle, metrics: EvalMetricSet): Promise<EvalStateSnapshot>;
  compareEvaluations(baselineId: string, candidateId: string): Promise<EvalComparisonResult>;
  checkForUpdate(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<string[]>;
  setUpdateChannel(channel: UpdateChannel): Promise<void>;
  openExternal(url: string): Promise<void>;
  onSnapshot(listener: (snapshot: AppSnapshot) => void): void;
  onProjection(listener: (change: ProjectionChange) => void): void;
  onOpenTask(listener: (taskId: string) => void): void;
}

export const IPC = {
  snapshotGet: "grokky:snapshot:get",
  snapshotChanged: "grokky:snapshot:changed",
  projectionChanged: "grokky:projection:changed",
  taskOpen: "grokky:tasks:open",
  conversationCreate: "grokky:conversation:create",
  conversationActivate: "grokky:conversation:activate",
  conversationUpdate: "grokky:conversation:update",
  conversationDelete: "grokky:conversation:delete",
  messageSend: "grokky:message:send",
  runCancel: "grokky:run:cancel",
  directoryChoose: "grokky:directory:choose",
  credentialChoose: "grokky:credential:choose",
  settingsUpdate: "grokky:settings:update",
  providersRefresh: "grokky:providers:refresh",
  capabilitiesGet: "grokky:capabilities:get",
  mcpRefresh: "grokky:capabilities:mcp-refresh",
  skillToggle: "grokky:capabilities:skill-toggle",
  mcpToggle: "grokky:capabilities:mcp-toggle",
  mcpToolClassify: "grokky:capabilities:mcp-tool-classify",
  mcpAuthBegin: "grokky:capabilities:mcp-auth-begin",
  mcpAuthComplete: "grokky:capabilities:mcp-auth-complete",
  mcpAuthRevoke: "grokky:capabilities:mcp-auth-revoke",
  connectorToggle: "grokky:capabilities:connector-toggle",
  agentsGet: "grokky:agents:get",
  agentCreate: "grokky:agents:create",
  agentUpdate: "grokky:agents:update",
  agentDelete: "grokky:agents:delete",
  agentMessageSend: "grokky:team:message-send",
  agentMessageAcknowledge: "grokky:team:message-acknowledge",
  agentMemoryPropose: "grokky:team:memory-propose",
  agentMemoryReview: "grokky:team:memory-review",
  agentRoutineCreate: "grokky:team:routine-create",
  persistentAgentUpdate: "grokky:team:agent-update",
  persistentAgentDuplicate: "grokky:team:agent-duplicate",
  computerEnabled: "grokky:computer:enabled",
  computerCapability: "grokky:computer:capability",
  computerPermission: "grokky:computer:permission",
  computerTest: "grokky:computer:test",
  computerPair: "grokky:computer:pair",
  computerSelect: "grokky:computer:select",
  computerRevoke: "grokky:computer:revoke",
  computerNetworkAllowlist: "grokky:computer:network-allowlist",
  computerApprovalResolve: "grokky:computer:approval-resolve",
  computerScreenTakeover: "grokky:computer:screen-takeover",
  computerScreenReturn: "grokky:computer:screen-return",
  computerScreenLock: "grokky:computer:screen-lock",
  taskGoalCreate: "grokky:tasks:goal-create",
  taskAction: "grokky:tasks:action",
  taskWorkspaceIntegrate: "grokky:tasks:workspace-integrate",
  taskControl: "grokky:tasks:control",
  controlPoliciesUpdate: "grokky:control:policies-update",
  traceQuery: "grokky:quality:trace-query",
  traceReplay: "grokky:quality:trace-replay",
  evalGet: "grokky:quality:eval-get",
  evalPromote: "grokky:quality:eval-promote",
  evalGrade: "grokky:quality:eval-grade",
  evalCompare: "grokky:quality:eval-compare",
  updateCheck: "grokky:update:check",
  updateDownload: "grokky:update:download",
  updateInstall: "grokky:update:install",
  updateChannel: "grokky:update:channel",
  externalOpen: "grokky:external:open",
} as const;

export const CODEX_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;

export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.2";
export const DEFAULT_PI_MODEL = "auto";
