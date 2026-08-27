import type { ActivityItem, AgentDefinition, AppSettings, Conversation, McpToolClassification, OrchestrationEvent, UsageSummary } from "../../shared/contracts";
import type { ComputerToolName } from "../computer-access";
import type { TaskControlRequest } from "../../shared/control-plane-contracts";
import type { PersistedComputerAccess } from "../state-store";

export type ProviderEvent =
  | { type: "thread"; threadId: string }
  | { type: "activity"; activity: ActivityItem }
  | { type: "orchestration"; event: OrchestrationEvent }
  | { type: "final"; text: string }
  | { type: "usage"; usage: UsageSummary };

export interface ProviderRunContext {
  conversation: Conversation;
  settings: AppSettings;
  agents: AgentDefinition[];
  prompt: string;
  signal: AbortSignal;
  selectedSkillPaths?: string[];
  computerAccess: PersistedComputerAccess;
  executeTool(name: ComputerToolName, args: Record<string, unknown>, options?: { readOnly?: boolean }): Promise<string>;
  controlTask?(taskId: string, request: TaskControlRequest): Promise<void>;
  mcpTools?: HarnessMcpTool[];
  executeMcpTool?(name: string, args: Record<string, unknown>, options?: { readOnly?: boolean }): Promise<string>;
  onEvent(event: ProviderEvent): void | Promise<void>;
}

export interface HarnessMcpTool {
  serverId: string;
  originalName: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  classification: McpToolClassification;
  classificationSource: "operator" | "server-annotation" | "safe-default";
}

export interface OpenRouterRunContext extends ProviderRunContext {
  apiKey: string;
}
