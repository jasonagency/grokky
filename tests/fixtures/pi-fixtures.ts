import { vi } from "vitest";
import type { PiSessionLike } from "../../src/main/harnesses/pi-adapter";
import type { ProviderEvent, ProviderRunContext } from "../../src/main/providers/types";
import type { AppSettings, Conversation } from "../../src/shared/contracts";
import { computerProviderContext } from "../provider-fixtures";

export class FakePiSession implements PiSessionLike {
  sessionId = "pi-session-id";
  sessionFile = "/tmp/pi-sessions/session.jsonl";
  model?: { provider: string; id: string };
  listeners: Array<(event: unknown) => void> = [];
  steer = vi.fn(async () => undefined);
  followUp = vi.fn(async () => undefined);
  abort = vi.fn(async () => undefined);
  dispose = vi.fn();
  subscribe(listener: (event: unknown) => void) { this.listeners.push(listener); return () => undefined; }
  async prompt() {
    for (const listener of this.listeners) {
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Pi answer" } });
      listener({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read_file" });
      listener({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read_file", isError: false });
      listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Pi answer" }] } });
    }
  }
  getLastAssistantText() { return "Pi answer"; }
  getSessionStats() { return { tokens: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 }, cost: 0.002 }; }
}

export function piContext(events: ProviderEvent[] = [], threadId?: string): ProviderRunContext {
  const now = Date.now();
  const conversation: Conversation = { id: "pi-conversation", title: "Pi", provider: "pi", harnessId: "pi-native", model: "anthropic/claude-sonnet-4-6", reasoning: "medium", sandboxMode: "workspace-write", allowCommands: false, projectMode: "project", workingDirectory: "/tmp", ...(threadId ? { threadId } : {}), messages: [], activities: [], selectedAgentIds: [], agentRuns: [], crewCommunications: [], status: "running", createdAt: now, updatedAt: now };
  const settings: AppSettings = { defaultWorkingDirectory: "/tmp", recentWorkingDirectories: [], openRouterCredentialPath: "", theme: "dark", multiAgentEnabled: true, maxAgentThreads: 2, defaultSubagentModel: "", defaultSubagentReasoning: "", interruptAgentMessage: true, connectorsEnabled: false, webSearchEnabled: false };
  return { conversation, settings, agents: [], prompt: "answer", signal: new AbortController().signal, ...computerProviderContext(conversation), onEvent: async (event) => { events.push(event); } };
}
