import type { AgentDefinition, Conversation, ReasoningEffort, SandboxMode } from "../shared/contracts";
import type { ProviderEvent } from "../main/providers/types";
import type { ComputerToolName } from "../main/computer-access";
import { defaultComputerAccess, defaultPersistentState } from "../main/state-store";
import { createDefaultHarnessRegistry, type HarnessRegistry } from "../main/harnesses/registry";
import { executeWorkspaceTool, type WorkspaceToolName } from "../main/workspace-tools";
import type { RemoteJobRecord } from "../shared/remote-protocol";
import { HostHarnessRegistry } from "./host-harness-registry";
import type { ScreenSessionManager } from "./screen-session-manager";
import type { ScreenKind, ScreenLease } from "../shared/remote-protocol";
import { CapabilitiesService } from "../main/capabilities";
import { McpAuthManager } from "../main/tools/mcp-auth";
import { McpClientManager } from "../main/tools/mcp-client-manager";
import { ToolGateway } from "../main/tools/tool-gateway";

interface RemoteHarnessPayload {
  prompt: string;
  model: string;
  reasoning: ReasoningEffort;
  sandboxMode: SandboxMode;
  allowCommands: boolean;
  threadId?: string;
  agents?: AgentDefinition[];
  selectedSkillPaths?: string[];
  screenKind?: ScreenKind;
}

export interface HostHarnessRegistryOptions {
  homeDirectory: string;
  root: string;
  allowWrite: boolean;
  allowCommands: boolean;
  harnessRegistry?: HarnessRegistry;
  screens?: ScreenSessionManager;
}

const workspaceTools = new Set<WorkspaceToolName>(["list_files", "search_files", "read_file", "create_file", "edit_file", "run_command"]);
const reasoningValues = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh"]);

function requirePayload(value: unknown): RemoteHarnessPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Remote harness payload must be an object");
  const input = value as Partial<RemoteHarnessPayload>;
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 200_000) throw new Error("Remote harness prompt is invalid");
  if (typeof input.model !== "string" || !input.model.trim() || input.model.length > 300) throw new Error("Remote harness model is invalid");
  if (!reasoningValues.has(input.reasoning as ReasoningEffort)) throw new Error("Remote harness reasoning is invalid");
  if (input.sandboxMode !== "read-only" && input.sandboxMode !== "workspace-write") throw new Error("Remote harness sandbox mode is invalid");
  if (typeof input.allowCommands !== "boolean") throw new Error("Remote harness command policy is invalid");
  if (input.threadId !== undefined && (typeof input.threadId !== "string" || !input.threadId || input.threadId.length > 4_000)) throw new Error("Remote harness session reference is invalid");
  if (input.agents !== undefined && (!Array.isArray(input.agents) || input.agents.length > 32)) throw new Error("Remote harness agent list is invalid");
  if (input.selectedSkillPaths !== undefined && (!Array.isArray(input.selectedSkillPaths) || input.selectedSkillPaths.length > 100 || input.selectedSkillPaths.some((path) => typeof path !== "string" || path.length > 4_000))) throw new Error("Remote harness skill list is invalid");
  if (input.screenKind !== undefined && input.screenKind !== "browser" && input.screenKind !== "desktop") throw new Error("Remote harness screen kind is invalid");
  return structuredClone(input) as RemoteHarnessPayload;
}

function conversation(job: RemoteJobRecord, payload: RemoteHarnessPayload, registry: HarnessRegistry, root: string): Conversation {
  const provider = registry.resolve({ provider: "codex", harnessId: job.harnessId }).descriptor.providerCompatibility[0];
  if (!provider) throw new Error(`Remote harness ${job.harnessId} has no compatible provider`);
  return {
    id: `remote:${job.id}`,
    title: `Remote task ${job.taskId}`,
    provider,
    harnessId: job.harnessId,
    model: payload.model,
    reasoning: payload.reasoning,
    sandboxMode: payload.sandboxMode,
    allowCommands: payload.allowCommands,
    projectMode: "project",
    workingDirectory: root,
    ...(payload.threadId ? { threadId: payload.threadId } : {}),
    messages: [], activities: [], selectedAgentIds: (payload.agents ?? []).map((agent) => agent.id), agentRuns: [], crewCommunications: [], harnessAttempts: [],
    status: "running", createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
}

function approvalRequired(name: ComputerToolName): boolean {
  return name === "create_file" || name === "edit_file" || name === "run_command" || name === "open_application" || name === "click_screen" || name === "type_text";
}

export async function createHostHarnessRegistry(options: HostHarnessRegistryOptions): Promise<HostHarnessRegistry> {
  const harnesses = options.harnessRegistry ?? createDefaultHarnessRegistry(options.homeDirectory);
  const hostRegistry = new HostHarnessRegistry();
  const capabilities = new CapabilitiesService(options.homeDirectory);
  const mcpConfigurations = await capabilities.mcpServerConfigurations();
  const toolGateway = new ToolGateway(new McpClientManager(new McpAuthManager()));
  hostRegistry.onCleanup(async () => { await Promise.all([harnesses.cleanup(), toolGateway.close()]); });
  const settings = defaultPersistentState(options.homeDirectory).settings;
  const readiness = await harnesses.snapshot(settings, options.homeDirectory);
  for (const entry of readiness) {
    hostRegistry.reportReadiness(entry.id, entry.health);
    if (!entry.health.ready) continue;
    const harnessId = entry.id;
    hostRegistry.register(harnessId, async (job, hostContext) => {
      const payload = requirePayload(job.payload);
      const runConversation = conversation(job, payload, harnesses, options.root);
      if (runConversation.sandboxMode === "workspace-write" && !options.allowWrite) throw new Error("Remote host was not provisioned for workspace writes");
      if (runConversation.allowCommands && !options.allowCommands) throw new Error("Remote host was not provisioned for commands");
      const computerAccess = defaultComputerAccess();
      computerAccess.grants.files = "allow";
      computerAccess.grants.commands = options.allowCommands ? "allow" : "blocked";
      computerAccess.grants.browser = "blocked";
      computerAccess.grants.screen = options.screens ? "allow" : "blocked";
      computerAccess.grants.automation = options.screens ? "allow" : "blocked";
      computerAccess.grants.mcp = "blocked";
      const mcpPolicies = settings.mcpToolPolicies ?? {};
      const preparedMcp = runConversation.provider === "openrouter" ? await toolGateway.prepare(mcpConfigurations, mcpPolicies) : { tools: [], results: [] };
      if (preparedMcp.tools.length) computerAccess.grants.mcp = "allow";
      let finalText = "";
      let costUsd = 0;
      let screenLease: ScreenLease | undefined;
      const leaseScreen = async () => {
        if (!options.screens) throw new Error("Remote host screen sessions are not provisioned");
        screenLease ??= await options.screens.lease(payload.agents?.[0]?.id ?? `remote:${job.id}`, payload.screenKind ?? "browser");
        return screenLease;
      };
      const emit = async (event: ProviderEvent): Promise<void> => {
        if (event.type === "final") finalText = event.text;
        if (event.type === "usage" && event.usage.costUsd !== undefined) {
          costUsd = Math.max(costUsd, event.usage.costUsd);
          if (costUsd > job.budgetUsd) throw new Error(`Remote job exceeded its $${job.budgetUsd.toFixed(2)} budget`);
        }
        await hostContext.emit("job.output", { event });
      };
      try {
        await harnesses.dispatch(runConversation, {
        conversation: runConversation,
        settings,
        agents: payload.agents ?? [],
        prompt: payload.prompt,
        signal: hostContext.signal,
        selectedSkillPaths: payload.selectedSkillPaths ?? [],
        computerAccess,
        mcpTools: preparedMcp.tools,
        executeMcpTool: async (name, args, executionOptions) => toolGateway.execute({
          configurations: mcpConfigurations,
          policies: mcpPolicies,
          name,
          args,
          readOnly: executionOptions?.readOnly === true,
          signal: hostContext.signal,
          authorize: async (tool) => {
            if (tool.classification === "read") return;
            if (job.approvalPolicy === "deny") throw new Error(`Remote host policy denied MCP tool ${tool.name}`);
            if (job.approvalPolicy === "ask") await hostContext.emit("job.approval", { action: tool.name, classification: tool.classification, taskId: job.taskId });
          },
        }),
        executeTool: async (name, args, executionOptions) => {
          if (approvalRequired(name)) {
            if (job.approvalPolicy === "deny") throw new Error(`Remote host policy denied ${name}`);
            if (job.approvalPolicy === "ask") await hostContext.emit("job.approval", { action: name, taskId: job.taskId });
          }
          if (workspaceTools.has(name as WorkspaceToolName)) {
            const readOnly = executionOptions?.readOnly === true || runConversation.sandboxMode === "read-only";
            return executeWorkspaceTool({ root: options.root, mode: readOnly ? "read-only" : "workspace-write", allowCommands: !readOnly && options.allowCommands && runConversation.allowCommands, name: name as WorkspaceToolName, args });
          }
          const lease = await leaseScreen();
          if (name === "capture_screen") return JSON.stringify(await options.screens!.capture(lease.id, lease.epoch));
          if (name === "click_screen") { await options.screens!.agentInput(lease.id, lease.epoch, lease.agentId, { type: "click", x: Number(args.x), y: Number(args.y) }); return "Remote screen click completed."; }
          if (name === "type_text") {
            const text = String(args.text ?? ""); if (!text || text.length > 2_000) throw new Error("Remote screen text must be between 1 and 2,000 characters");
            for (const key of text) await options.screens!.agentInput(lease.id, lease.epoch, lease.agentId, { type: "key", key });
            return "Remote screen text input completed; content was excluded from the trace.";
          }
          throw new Error(`Remote host tool ${name} is not provisioned`);
        },
        onEvent: emit,
        });
        return finalText || `Remote harness ${harnessId} completed`;
      } finally {
        if (screenLease) await options.screens?.revoke(screenLease.id, screenLease.epoch).catch(() => undefined);
      }
    });
  }
  return hostRegistry;
}
