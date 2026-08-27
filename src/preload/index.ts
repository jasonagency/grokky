import { contextBridge, ipcRenderer } from "electron";
import type { AppSnapshot, AppSettings, ConversationPatch, GrokkyApi } from "../shared/contracts";
import type { ProjectionChange } from "../shared/control-plane-contracts";
import { IPC } from "../shared/contracts";
import { userFacingError } from "../shared/errors";

let snapshotListener: ((_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => void) | undefined;
let projectionListener: ((_event: Electron.IpcRendererEvent, change: ProjectionChange) => void) | undefined;

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return await ipcRenderer.invoke(channel, ...args) as T;
  } catch (error) {
    throw new Error(userFacingError(error, "Grokky could not complete that request"));
  }
}

const api: GrokkyApi = {
  getSnapshot: () => invoke(IPC.snapshotGet),
  createConversation: () => invoke(IPC.conversationCreate),
  setActiveConversation: (conversationId) => invoke(IPC.conversationActivate, conversationId),
  updateConversation: (conversationId, patch: ConversationPatch) => invoke(IPC.conversationUpdate, conversationId, patch),
  deleteConversation: (conversationId) => invoke(IPC.conversationDelete, conversationId),
  sendMessage: (conversationId, text) => invoke(IPC.messageSend, conversationId, text),
  cancelRun: (conversationId) => invoke(IPC.runCancel, conversationId),
  chooseWorkingDirectory: (conversationId) => invoke(IPC.directoryChoose, conversationId),
  chooseOpenRouterCredential: () => invoke(IPC.credentialChoose),
  updateSettings: (patch: Partial<AppSettings>) => invoke(IPC.settingsUpdate, patch),
  refreshProviderStatuses: () => invoke(IPC.providersRefresh),
  getCapabilities: () => invoke(IPC.capabilitiesGet),
  refreshMcpCapabilities: () => invoke(IPC.mcpRefresh),
  setSkillEnabled: (path, enabled) => invoke(IPC.skillToggle, path, enabled),
  setMcpEnabled: (id, enabled) => invoke(IPC.mcpToggle, id, enabled),
  setMcpToolClassification: (name, classification) => invoke(IPC.mcpToolClassify, name, classification),
  beginMcpAuthorization: (id) => invoke(IPC.mcpAuthBegin, id),
  completeMcpAuthorization: (id, code) => invoke(IPC.mcpAuthComplete, id, code),
  revokeMcpAuthorization: (id) => invoke(IPC.mcpAuthRevoke, id),
  setConnectorEnabled: (id, enabled) => invoke(IPC.connectorToggle, id, enabled),
  getAgents: () => invoke(IPC.agentsGet),
  createAgent: (draft) => invoke(IPC.agentCreate, draft),
  updateAgent: (id, draft) => invoke(IPC.agentUpdate, id, draft),
  deleteAgent: (id) => invoke(IPC.agentDelete, id),
  sendAgentMessage: (input) => invoke(IPC.agentMessageSend, input),
  acknowledgeAgentMessage: (messageId, agentId) => invoke(IPC.agentMessageAcknowledge, messageId, agentId),
  proposeAgentMemory: (input) => invoke(IPC.agentMemoryPropose, input),
  reviewAgentMemory: (id, decision) => invoke(IPC.agentMemoryReview, id, decision),
  createAgentRoutine: (input) => invoke(IPC.agentRoutineCreate, input),
  updatePersistentAgent: (agentId, action) => invoke(IPC.persistentAgentUpdate, agentId, action),
  duplicatePersistentAgent: (agentId, name) => invoke(IPC.persistentAgentDuplicate, agentId, name),
  setComputerAccessEnabled: (enabled) => invoke(IPC.computerEnabled, enabled),
  setComputerCapability: (id, level) => invoke(IPC.computerCapability, id, level),
  requestComputerPermission: (id) => invoke(IPC.computerPermission, id),
  testComputerCapability: (id) => invoke(IPC.computerTest, id),
  pairComputer: (endpoint, code) => invoke(IPC.computerPair, endpoint, code),
  selectComputer: (deviceId) => invoke(IPC.computerSelect, deviceId),
  revokeComputer: (deviceId) => invoke(IPC.computerRevoke, deviceId),
  updateComputerNetworkAllowlist: (domains) => invoke(IPC.computerNetworkAllowlist, domains),
  resolveComputerApproval: (id, decision) => invoke(IPC.computerApprovalResolve, id, decision),
  takeoverScreen: (leaseId, epoch) => invoke(IPC.computerScreenTakeover, leaseId, epoch),
  returnScreen: (leaseId, epoch) => invoke(IPC.computerScreenReturn, leaseId, epoch),
  lockScreen: (leaseId, epoch) => invoke(IPC.computerScreenLock, leaseId, epoch),
  createTaskGoal: (draft) => invoke(IPC.taskGoalCreate, draft),
  actOnTask: (taskId, action) => invoke(IPC.taskAction, taskId, action),
  controlTask: (taskId, control) => invoke(IPC.taskControl, taskId, control),
  updateControlPolicies: (patch) => invoke(IPC.controlPoliciesUpdate, patch),
  queryTrace: (query) => invoke(IPC.traceQuery, query),
  replayTrace: (request) => invoke(IPC.traceReplay, request),
  getEvaluations: () => invoke(IPC.evalGet),
  promoteEvaluation: (input) => invoke(IPC.evalPromote, input),
  gradeEvaluation: (caseId, version, trace, metrics) => invoke(IPC.evalGrade, caseId, version, trace, metrics),
  compareEvaluations: (baselineId, candidateId) => invoke(IPC.evalCompare, baselineId, candidateId),
  openExternal: (url) => invoke(IPC.externalOpen, url),
  onSnapshot: (listener: (snapshot: AppSnapshot) => void) => {
    if (snapshotListener) ipcRenderer.removeListener(IPC.snapshotChanged, snapshotListener);
    snapshotListener = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => listener(snapshot);
    ipcRenderer.on(IPC.snapshotChanged, snapshotListener);
  },
  onProjection: (listener: (change: ProjectionChange) => void) => {
    if (projectionListener) ipcRenderer.removeListener(IPC.projectionChanged, projectionListener);
    projectionListener = (_event: Electron.IpcRendererEvent, change: ProjectionChange) => listener(change);
    ipcRenderer.on(IPC.projectionChanged, projectionListener);
  },
};

contextBridge.exposeInMainWorld("grokky", api);
