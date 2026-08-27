import { randomUUID } from "node:crypto";
import { extname, join, resolve } from "node:path";
import type {
  AgentRun,
  AppSettings,
  ComputerAccessLevel,
  ComputerAuditEntry,
  ComputerCapabilityId,
  Conversation,
  CrewCommunication,
} from "../shared/contracts";
import type { HarnessAttempt } from "../shared/harness-contracts";
import { DirectDatabaseClient } from "./storage/database-client";
import type { ControlPlaneDatabase } from "./storage/database-types";
import { readLegacyState } from "./storage/legacy-import";
import { decodePersistentSnapshot, encodePersistentSnapshot } from "./storage/repositories/snapshot-repository";

export interface PersistedRemoteDevice {
  id: string;
  name: string;
  platform: string;
  endpoint: string;
  root: string;
  encryptedToken: string;
  capabilities: ComputerCapabilityId[];
  lastSeenAt: number;
  revoked: boolean;
}

export interface PersistedComputerAccess {
  enabled: boolean;
  localDeviceId: string;
  activeDeviceId: string;
  grants: Record<ComputerCapabilityId, ComputerAccessLevel>;
  networkAllowlist: string[];
  remoteDevices: PersistedRemoteDevice[];
  auditLog: ComputerAuditEntry[];
}

export interface PersistentState {
  version: 2;
  conversations: Conversation[];
  activeConversationId?: string;
  settings: AppSettings;
  computerAccess: PersistedComputerAccess;
}

export function noProjectDirectory(homeDirectory: string): string {
  return join(homeDirectory, ".grokky", "no-project");
}

export function defaultComputerAccess(): PersistedComputerAccess {
  const localDeviceId = `local-${randomUUID().replaceAll("-", "")}`;
  return {
    enabled: true,
    localDeviceId,
    activeDeviceId: localDeviceId,
    grants: {
      files: "allow",
      commands: "ask",
      browser: "ask",
      screen: "ask",
      automation: "ask",
    },
    networkAllowlist: [],
    remoteDevices: [],
    auditLog: [],
  };
}

export function defaultPersistentState(homeDirectory: string): PersistentState {
  const scratchDirectory = noProjectDirectory(homeDirectory);
  return {
    version: 2,
    conversations: [],
    settings: {
      defaultWorkingDirectory: scratchDirectory,
      recentWorkingDirectories: [],
      openRouterCredentialPath: "",
      theme: "system",
      accentPalette: "lime",
      multiAgentEnabled: true,
      maxAgentThreads: 4,
      defaultSubagentModel: "",
      defaultSubagentReasoning: "",
      interruptAgentMessage: true,
      connectorsEnabled: true,
      webSearchEnabled: true,
    },
    computerAccess: defaultComputerAccess(),
  };
}

const capabilityIds = new Set<ComputerCapabilityId>(["files", "commands", "browser", "screen", "automation"]);
const accessLevels = new Set<ComputerAccessLevel>(["blocked", "ask", "allow"]);

function normalizeComputerAccess(value: unknown): PersistedComputerAccess {
  const fallback = defaultComputerAccess();
  if (!value || typeof value !== "object") return fallback;
  const input = value as Partial<PersistedComputerAccess>;
  const localDeviceId = typeof input.localDeviceId === "string" && /^local-[a-zA-Z0-9_-]{12,100}$/.test(input.localDeviceId)
    ? input.localDeviceId
    : fallback.localDeviceId;
  const grants = { ...fallback.grants };
  if (input.grants && typeof input.grants === "object") {
    for (const capability of capabilityIds) {
      const level = input.grants[capability];
      if (accessLevels.has(level)) grants[capability] = level;
    }
  }
  const remoteDevices = Array.isArray(input.remoteDevices)
    ? input.remoteDevices.flatMap((item): PersistedRemoteDevice[] => {
        if (!item || typeof item !== "object") return [];
        const device = item as Partial<PersistedRemoteDevice>;
        if (
          typeof device.id !== "string"
          || typeof device.name !== "string"
          || typeof device.platform !== "string"
          || typeof device.endpoint !== "string"
          || typeof device.root !== "string"
          || typeof device.encryptedToken !== "string"
        ) return [];
        return [{
          id: device.id,
          name: device.name.slice(0, 120),
          platform: device.platform.slice(0, 80),
          endpoint: device.endpoint,
          root: device.root,
          encryptedToken: device.encryptedToken,
          capabilities: Array.isArray(device.capabilities)
            ? device.capabilities.filter((capability): capability is ComputerCapabilityId => capabilityIds.has(capability as ComputerCapabilityId))
            : ["files"],
          lastSeenAt: typeof device.lastSeenAt === "number" ? device.lastSeenAt : 0,
          revoked: device.revoked === true,
        }];
      }).slice(0, 24)
    : [];
  const validDeviceIds = new Set([localDeviceId, ...remoteDevices.filter((device) => !device.revoked).map((device) => device.id)]);
  const activeDeviceId = typeof input.activeDeviceId === "string" && validDeviceIds.has(input.activeDeviceId)
    ? input.activeDeviceId
    : localDeviceId;
  const auditLog = Array.isArray(input.auditLog)
    ? input.auditLog.filter((entry): entry is ComputerAuditEntry => Boolean(
        entry
        && typeof entry === "object"
        && typeof (entry as ComputerAuditEntry).id === "string"
        && capabilityIds.has((entry as ComputerAuditEntry).capability),
      )).slice(-250)
    : [];
  return {
    enabled: input.enabled !== false,
    localDeviceId,
    activeDeviceId,
    grants,
    networkAllowlist: Array.isArray(input.networkAllowlist)
      ? input.networkAllowlist.filter((domain): domain is string => typeof domain === "string").map((domain) => domain.trim().toLowerCase()).filter(Boolean).slice(0, 100)
      : [],
    remoteDevices,
    auditLog,
  };
}

function normalizeAgentRun(value: unknown): AgentRun | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<AgentRun>;
  if (typeof item.id !== "string" || typeof item.threadId !== "string" || typeof item.task !== "string") return null;
  const now = Date.now();
  const allowed = new Set<AgentRun["status"]>(["starting", "working", "waiting", "completed", "failed", "stopped"]);
  const storedStatus = allowed.has(item.status as AgentRun["status"]) ? item.status as AgentRun["status"] : "stopped";
  return {
    id: item.id,
    operationId: typeof item.operationId === "string" ? item.operationId : item.id,
    threadId: item.threadId,
    name: typeof item.name === "string" ? item.name : "Crew member",
    task: item.task,
    status: new Set<AgentRun["status"]>(["starting", "working", "waiting"]).has(storedStatus) ? "stopped" : storedStatus,
    ...(typeof item.result === "string" ? { result: item.result } : {}),
    createdAt: typeof item.createdAt === "number" ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : now,
  };
}

function normalizeCrewCommunication(value: unknown): CrewCommunication | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<CrewCommunication>;
  const kinds = new Set<CrewCommunication["kind"]>(["assignment", "message", "report", "status"]);
  const statuses = new Set<CrewCommunication["status"]>(["running", "completed", "failed"]);
  if (
    typeof item.id !== "string"
    || typeof item.operationId !== "string"
    || typeof item.tool !== "string"
    || !kinds.has(item.kind as CrewCommunication["kind"])
    || typeof item.senderThreadId !== "string"
    || typeof item.senderName !== "string"
    || typeof item.receiverThreadId !== "string"
    || typeof item.receiverName !== "string"
    || !statuses.has(item.status as CrewCommunication["status"])
  ) return null;
  return {
    id: item.id,
    operationId: item.operationId,
    tool: item.tool,
    kind: item.kind as CrewCommunication["kind"],
    senderThreadId: item.senderThreadId,
    senderName: item.senderName.slice(0, 120),
    receiverThreadId: item.receiverThreadId,
    receiverName: item.receiverName.slice(0, 120),
    ...(typeof item.content === "string" ? { content: item.content.slice(0, 12_000) } : {}),
    status: item.status as CrewCommunication["status"],
    createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
  };
}

function isBenignSkillsNotice(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as { detail?: unknown };
  return typeof item.detail === "string" && item.detail.startsWith("Skill descriptions were shortened to fit the skills context budget.");
}

function normalizeConversation(value: unknown, homeDirectory: string): Conversation | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<Conversation>;
  if (typeof item.id !== "string" || typeof item.title !== "string") return null;
  const now = Date.now();
  const scratchDirectory = noProjectDirectory(homeDirectory);
  const storedDirectory = typeof item.workingDirectory === "string" && item.workingDirectory
    ? item.workingDirectory
    : scratchDirectory;
  const inferredProjectMode = resolve(storedDirectory) === resolve(homeDirectory)
    || resolve(storedDirectory) === resolve(scratchDirectory)
    ? "none"
    : "project";
  const projectMode = item.projectMode === "project" || item.projectMode === "none"
    ? item.projectMode
    : inferredProjectMode;
  const runOutcomes = new Set<NonNullable<Conversation["lastRunOutcome"]>>(["delivered", "blocked", "failed", "stopped"]);
  const provider = item.provider === "openrouter" ? "openrouter" : "codex";
  const harnessAttempts = Array.isArray(item.harnessAttempts)
    ? item.harnessAttempts.flatMap((value): HarnessAttempt[] => {
        if (!value || typeof value !== "object") return [];
        const attempt = value as Partial<HarnessAttempt>;
        if (
          typeof attempt.id !== "string"
          || typeof attempt.harnessId !== "string"
          || typeof attempt.adapterVersion !== "string"
          || !["running", "completed", "failed", "stopped"].includes(attempt.status ?? "")
          || typeof attempt.startedAt !== "number"
        ) return [];
        return [{
          id: attempt.id,
          harnessId: attempt.harnessId,
          adapterVersion: attempt.adapterVersion,
          status: attempt.status as HarnessAttempt["status"],
          ...(attempt.session && typeof attempt.session.nativeSessionId === "string" ? { session: attempt.session } : {}),
          startedAt: attempt.startedAt,
          ...(typeof attempt.endedAt === "number" ? { endedAt: attempt.endedAt } : {}),
        }];
      }).slice(-40)
    : [];
  return {
    id: item.id,
    title: item.title,
    provider,
    harnessId: typeof item.harnessId === "string" ? item.harnessId : provider === "codex" ? "codex-sdk" : "openrouter-chat",
    model: typeof item.model === "string" ? item.model : "gpt-5.6-sol",
    reasoning: ["low", "medium", "high", "xhigh"].includes(item.reasoning ?? "") ? item.reasoning! : "medium",
    sandboxMode: item.sandboxMode === "read-only" ? "read-only" : "workspace-write",
    allowCommands: item.allowCommands === true,
    projectMode,
    workingDirectory: projectMode === "project" ? storedDirectory : scratchDirectory,
    ...(typeof item.threadId === "string" ? { threadId: item.threadId } : {}),
    messages: Array.isArray(item.messages) ? item.messages : [],
    activities: Array.isArray(item.activities) ? item.activities.filter((activity) => !isBenignSkillsNotice(activity)).slice(-80) : [],
    selectedAgentIds: Array.isArray(item.selectedAgentIds)
      ? item.selectedAgentIds.filter((agentId): agentId is string => typeof agentId === "string").slice(0, 8)
      : [],
    agentRuns: Array.isArray(item.agentRuns)
      ? item.agentRuns.map(normalizeAgentRun).filter((run): run is AgentRun => Boolean(run)).slice(-40)
      : [],
    crewCommunications: Array.isArray(item.crewCommunications)
      ? item.crewCommunications.map(normalizeCrewCommunication).filter((entry): entry is CrewCommunication => Boolean(entry)).slice(-80)
      : [],
    harnessAttempts,
    ...(item.usage ? { usage: item.usage } : {}),
    status: "idle",
    ...(runOutcomes.has(item.lastRunOutcome as NonNullable<Conversation["lastRunOutcome"]>) ? { lastRunOutcome: item.lastRunOutcome } : {}),
    ...(typeof item.error === "string" ? { error: item.error } : {}),
    createdAt: typeof item.createdAt === "number" ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : now,
  };
}

export function normalizePersistentState(
  value: unknown,
  homeDirectory: string,
  onDiagnostic?: (message: string) => void,
): PersistentState {
  const fallback = defaultPersistentState(homeDirectory);
  if (!value || typeof value !== "object") return fallback;
  const parsed = value as Partial<PersistentState>;
  const rawConversations = Array.isArray(parsed.conversations) ? parsed.conversations : [];
  const conversations = rawConversations
    .map((item) => normalizeConversation(item, homeDirectory))
    .filter((item): item is Conversation => Boolean(item));
  const invalidConversationCount = rawConversations.length - conversations.length;
  if (invalidConversationCount > 0) {
    onDiagnostic?.(`Skipped ${invalidConversationCount} invalid legacy conversation ${invalidConversationCount === 1 ? "record" : "records"}.`);
  }
  const settings = parsed.settings && typeof parsed.settings === "object" ? parsed.settings : fallback.settings;
  const scratchDirectory = noProjectDirectory(homeDirectory);
  const storedDefaultDirectory = typeof settings.defaultWorkingDirectory === "string"
    ? settings.defaultWorkingDirectory
    : fallback.settings.defaultWorkingDirectory;
  const defaultWorkingDirectory = resolve(storedDefaultDirectory) === resolve(homeDirectory)
    ? scratchDirectory
    : storedDefaultDirectory;
  const storedRecentDirectories = Array.isArray(settings.recentWorkingDirectories)
    ? settings.recentWorkingDirectories.filter((pathname): pathname is string => (
        typeof pathname === "string"
        && pathname.length > 0
        && resolve(pathname) !== resolve(homeDirectory)
        && resolve(pathname) !== resolve(scratchDirectory)
      ))
    : [];
  const conversationDirectories = conversations.flatMap((conversation) => conversation.projectMode === "project" ? [conversation.workingDirectory] : []);
  const recentWorkingDirectories = [...new Set([...storedRecentDirectories, ...conversationDirectories])].slice(0, 12);
  const activeConversationId = conversations.some((item) => item.id === parsed.activeConversationId)
    ? parsed.activeConversationId
    : conversations[0]?.id;
  return {
    version: 2,
    conversations,
    ...(activeConversationId ? { activeConversationId } : {}),
    settings: {
      defaultWorkingDirectory,
      recentWorkingDirectories,
      openRouterCredentialPath: typeof settings.openRouterCredentialPath === "string"
        ? settings.openRouterCredentialPath
        : "",
      theme: ["system", "light", "dark"].includes(settings.theme) ? settings.theme : "system",
      accentPalette: typeof settings.accentPalette === "string"
        && ["lime", "electric-blue", "ultraviolet", "solar-amber", "ice"].includes(settings.accentPalette)
        ? settings.accentPalette as AppSettings["accentPalette"]
        : "lime",
      multiAgentEnabled: typeof settings.multiAgentEnabled === "boolean" ? settings.multiAgentEnabled : true,
      maxAgentThreads: typeof settings.maxAgentThreads === "number"
        ? Math.max(1, Math.min(8, Math.round(settings.maxAgentThreads)))
        : 4,
      defaultSubagentModel: typeof settings.defaultSubagentModel === "string" ? settings.defaultSubagentModel : "",
      defaultSubagentReasoning: typeof settings.defaultSubagentReasoning === "string"
        && ["", "low", "medium", "high", "xhigh"].includes(settings.defaultSubagentReasoning)
        ? settings.defaultSubagentReasoning as AppSettings["defaultSubagentReasoning"]
        : "",
      interruptAgentMessage: typeof settings.interruptAgentMessage === "boolean" ? settings.interruptAgentMessage : true,
      connectorsEnabled: typeof settings.connectorsEnabled === "boolean" ? settings.connectorsEnabled : true,
      webSearchEnabled: typeof settings.webSearchEnabled === "boolean" ? settings.webSearchEnabled : true,
    },
    computerAccess: normalizeComputerAccess(parsed.computerAccess),
  };
}

interface StateStoreOptions {
  database?: ControlPlaneDatabase;
  legacyPath?: string;
  onDiagnostic?(message: string): void;
}

export function sqlitePathForLegacy(pathname: string): string {
  return extname(pathname).toLowerCase() === ".json" ? `${pathname.slice(0, -5)}.sqlite3` : pathname;
}

export class StateStore {
  private readonly database: ControlPlaneDatabase;
  private readonly legacyPath?: string;
  private initialized = false;

  constructor(
    pathname: string,
    private readonly homeDirectory: string,
    private readonly options: StateStoreOptions = {},
  ) {
    const databasePath = sqlitePathForLegacy(pathname);
    this.database = options.database ?? new DirectDatabaseClient(databasePath);
    this.legacyPath = options.legacyPath ?? (databasePath === pathname ? undefined : pathname);
  }

  async load(): Promise<PersistentState> {
    const fallback = defaultPersistentState(this.homeDirectory);
    await this.ensureInitialized();
    const storedSnapshot = await this.database.readSnapshot();
    if (storedSnapshot) return normalizePersistentState(decodePersistentSnapshot(storedSnapshot), this.homeDirectory);

    if (this.legacyPath) {
      const legacy = await readLegacyState(this.legacyPath);
      if (legacy) {
        const importedState = normalizePersistentState(legacy.raw, this.homeDirectory, this.options.onDiagnostic);
        await this.database.importLegacySnapshot(encodePersistentSnapshot(importedState), legacy.pathname, Date.now());
        const importedSnapshot = await this.database.readSnapshot();
        if (importedSnapshot) {
          return normalizePersistentState(decodePersistentSnapshot(importedSnapshot), this.homeDirectory);
        }
      }
    }
    return fallback;
  }

  async save(state: PersistentState): Promise<void> {
    await this.ensureInitialized();
    await this.database.writeSnapshot(encodePersistentSnapshot(state));
  }

  async close(): Promise<void> {
    if (!this.initialized) return;
    await this.database.close();
    this.initialized = false;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.database.initialize();
    this.initialized = true;
  }
}
