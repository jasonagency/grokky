import { dialog, ipcMain, shell } from "electron";
import type { MainController } from "./controller";
import { IPC } from "../shared/contracts";
import { validateTaskAction, validateTaskGoalDraft, validateTaskId } from "./control-plane/task-graph";
import type { ControlPolicyPatch, TaskControlRequest } from "../shared/control-plane-contracts";
import type { McpToolClassification } from "../shared/contracts";
import {
  requireComputerAccessLevel,
  requireComputerApprovalDecision,
  requireComputerCapability,
  requireId,
  requireMessage,
  requireNetworkAllowlist,
  requirePairingCode,
  requireRunnerEndpoint,
  validateAgentDraft,
  validateConversationPatch,
  validateSettingsPatch,
} from "../shared/validation";

export function registerIpc(controller: MainController): void {
  ipcMain.handle(IPC.snapshotGet, () => controller.snapshot());
  ipcMain.handle(IPC.conversationCreate, () => controller.createConversation());
  ipcMain.handle(IPC.conversationActivate, (_event, conversationId) => controller.setActiveConversation(requireId(conversationId, "conversation ID")));
  ipcMain.handle(IPC.conversationUpdate, (_event, conversationId, patch) => controller.updateConversation(
    requireId(conversationId, "conversation ID"),
    validateConversationPatch(patch),
  ));
  ipcMain.handle(IPC.conversationDelete, (_event, conversationId) => controller.deleteConversation(requireId(conversationId, "conversation ID")));
  ipcMain.handle(IPC.messageSend, (_event, conversationId, text) => controller.sendMessage(
    requireId(conversationId, "conversation ID"),
    requireMessage(text),
  ));
  ipcMain.handle(IPC.runCancel, (_event, conversationId) => controller.cancelRun(requireId(conversationId, "conversation ID")));
  ipcMain.handle(IPC.directoryChoose, async (_event, conversationId) => {
    const id = requireId(conversationId, "conversation ID");
    const result = await dialog.showOpenDialog({ title: "Choose Grokky workspace", properties: ["openDirectory", "createDirectory"] });
    const pathname = result.canceled ? null : result.filePaths[0] ?? null;
    if (pathname) await controller.updateConversation(id, { workingDirectory: pathname });
    return pathname;
  });
  ipcMain.handle(IPC.credentialChoose, async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose an env file containing OPENROUTER_API_KEY",
      properties: ["openFile", "showHiddenFiles"],
    });
    const pathname = result.canceled ? null : result.filePaths[0] ?? null;
    if (pathname) await controller.updateSettings({ openRouterCredentialPath: pathname });
    return pathname;
  });
  ipcMain.handle(IPC.settingsUpdate, (_event, patch) => controller.updateSettings(validateSettingsPatch(patch)));
  ipcMain.handle(IPC.providersRefresh, () => controller.refreshProviderStatuses());
  ipcMain.handle(IPC.capabilitiesGet, () => controller.getCapabilities());
  ipcMain.handle(IPC.mcpRefresh, () => controller.refreshMcpCapabilities());
  ipcMain.handle(IPC.skillToggle, (_event, pathname, enabled) => {
    if (typeof pathname !== "string" || pathname.length > 4_000 || typeof enabled !== "boolean") throw new Error("Invalid skill update");
    return controller.setSkillEnabled(pathname, enabled);
  });
  ipcMain.handle(IPC.mcpToggle, (_event, id, enabled) => {
    if (typeof id !== "string" || id.length > 240 || typeof enabled !== "boolean") throw new Error("Invalid MCP update");
    return controller.setMcpEnabled(id, enabled);
  });
  ipcMain.handle(IPC.mcpToolClassify, (_event, name, value) => {
    if (typeof name !== "string" || typeof value !== "string") throw new Error("Invalid MCP tool policy");
    return controller.setMcpToolClassification(name, value as McpToolClassification);
  });
  ipcMain.handle(IPC.mcpAuthBegin, async (_event, id) => {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_@./-]{1,240}$/.test(id)) throw new Error("Invalid MCP server ID");
    const serverId = id;
    const url = await controller.beginMcpAuthorization(serverId);
    if (url !== "authorized") {
      const target = new URL(url);
      const loopback = target.hostname === "localhost" || target.hostname === "127.0.0.1" || target.hostname === "::1";
      if (target.protocol !== "https:" && !(target.protocol === "http:" && loopback)) throw new Error("MCP authorization URL must use HTTPS or loopback HTTP");
      await shell.openExternal(target.toString());
    }
    return url;
  });
  ipcMain.handle(IPC.mcpAuthComplete, (_event, id, callback) => {
    if (typeof callback !== "string" || !callback.trim() || callback.length > 8_000) throw new Error("Invalid MCP authorization callback");
    if (typeof id !== "string" || !/^[a-zA-Z0-9_@./-]{1,240}$/.test(id)) throw new Error("Invalid MCP server ID");
    return controller.completeMcpAuthorization(id, callback);
  });
  ipcMain.handle(IPC.mcpAuthRevoke, (_event, id) => {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_@./-]{1,240}$/.test(id)) throw new Error("Invalid MCP server ID");
    return controller.revokeMcpAuthorization(id);
  });
  ipcMain.handle(IPC.connectorToggle, (_event, id, enabled) => {
    if (typeof id !== "string" || id.length > 240 || typeof enabled !== "boolean") throw new Error("Invalid connector update");
    return controller.setConnectorEnabled(id, enabled);
  });
  ipcMain.handle(IPC.agentsGet, () => controller.getAgents());
  ipcMain.handle(IPC.agentCreate, (_event, draft) => controller.createAgent(validateAgentDraft(draft)));
  ipcMain.handle(IPC.agentUpdate, (_event, id, draft) => {
    if (typeof id !== "string" || !/^[a-zA-Z0-9:_-]{3,100}$/.test(id)) throw new Error("Invalid agent ID");
    return controller.updateAgent(id, validateAgentDraft(draft));
  });
  ipcMain.handle(IPC.agentDelete, (_event, id) => {
    if (typeof id !== "string" || !/^[a-zA-Z0-9:_-]{3,100}$/.test(id)) throw new Error("Invalid agent ID");
    return controller.deleteAgent(id);
  });
  ipcMain.handle(IPC.computerEnabled, (_event, enabled) => {
    if (typeof enabled !== "boolean") throw new Error("Invalid computer access setting");
    return controller.setComputerAccessEnabled(enabled);
  });
  ipcMain.handle(IPC.computerCapability, (_event, capability, level) => controller.setComputerCapability(
    requireComputerCapability(capability),
    requireComputerAccessLevel(level),
  ));
  ipcMain.handle(IPC.computerPermission, (_event, capability) => controller.requestComputerPermission(requireComputerCapability(capability)));
  ipcMain.handle(IPC.computerTest, (_event, capability) => controller.testComputerCapability(requireComputerCapability(capability)));
  ipcMain.handle(IPC.computerPair, (_event, endpoint, code) => controller.pairComputer(requireRunnerEndpoint(endpoint), requirePairingCode(code)));
  ipcMain.handle(IPC.computerSelect, (_event, deviceId) => controller.selectComputer(requireId(deviceId, "computer ID")));
  ipcMain.handle(IPC.computerRevoke, (_event, deviceId) => controller.revokeComputer(requireId(deviceId, "computer ID")));
  ipcMain.handle(IPC.computerNetworkAllowlist, (_event, domains) => controller.updateComputerNetworkAllowlist(requireNetworkAllowlist(domains)));
  ipcMain.handle(IPC.computerApprovalResolve, (_event, approvalId, decision) => controller.resolveComputerApproval(
    requireId(approvalId, "approval ID"),
    requireComputerApprovalDecision(decision),
  ));
  ipcMain.handle(IPC.taskGoalCreate, (_event, draft) => controller.createTaskGoal(validateTaskGoalDraft(draft)));
  ipcMain.handle(IPC.taskAction, (_event, taskId, action) => controller.actOnTask(
    validateTaskId(taskId),
    validateTaskAction(action),
  ));
  ipcMain.handle(IPC.taskControl, (_event, taskId, value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid task control");
    const control = value as Partial<TaskControlRequest>;
    if (!new Set(["redirect", "follow-up", "pause", "resume", "stop", "reprioritize", "message"]).has(String(control.type))) throw new Error("Invalid task control type");
    if (typeof control.idempotencyKey !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(control.idempotencyKey)) throw new Error("Invalid task control idempotency key");
    if (control.message !== undefined && (typeof control.message !== "string" || !control.message.trim() || control.message.length > 2_000)) throw new Error("Invalid task control message");
    if (control.priority !== undefined && (!Number.isInteger(control.priority) || control.priority < -100 || control.priority > 100)) throw new Error("Invalid task control priority");
    return controller.controlTask(validateTaskId(taskId), control as TaskControlRequest);
  });
  ipcMain.handle(IPC.controlPoliciesUpdate, (_event, value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid control policy update");
    const patch = structuredClone(value) as ControlPolicyPatch;
    if (patch.budgetPolicy && (!Number.isFinite(patch.budgetPolicy.reserveFraction) || patch.budgetPolicy.reserveFraction < 0 || patch.budgetPolicy.reserveFraction > 1)) throw new Error("Invalid budget reserve");
    return controller.updateControlPolicies(patch);
  });
  ipcMain.handle(IPC.traceQuery, (_event, value) => {
    if (!value || typeof value !== "object" || JSON.stringify(value).length > 8_000) throw new Error("Invalid trace query");
    return controller.queryTrace(structuredClone(value));
  });
  ipcMain.handle(IPC.traceReplay, (_event, value) => {
    if (!value || typeof value !== "object" || JSON.stringify(value).length > 2_000_000) throw new Error("Invalid replay request");
    return controller.replayTrace(structuredClone(value));
  });
  ipcMain.handle(IPC.evalGet, () => controller.getEvaluations());
  ipcMain.handle(IPC.evalPromote, (_event, value) => {
    if (!value || typeof value !== "object" || JSON.stringify(value).length > 2_000_000) throw new Error("Invalid evaluation case");
    return controller.promoteEvaluation(structuredClone(value));
  });
  ipcMain.handle(IPC.evalGrade, (_event, caseId, version, trace, metrics) => {
    if (typeof caseId !== "string" || caseId.length > 160 || !Number.isInteger(version)) throw new Error("Invalid evaluation run");
    return controller.gradeEvaluation(caseId, version, structuredClone(trace), structuredClone(metrics));
  });
  ipcMain.handle(IPC.evalCompare, (_event, baselineId, candidateId) => {
    if (typeof baselineId !== "string" || typeof candidateId !== "string") throw new Error("Invalid evaluation comparison");
    return controller.compareEvaluations(baselineId, candidateId);
  });
  ipcMain.handle(IPC.externalOpen, async (_event, value) => {
    if (typeof value !== "string") throw new Error("Invalid URL");
    const url = new URL(value);
    if (!new Set(["https:", "http:"]).has(url.protocol)) throw new Error("Only web links can be opened");
    await shell.openExternal(url.toString());
  });
}
