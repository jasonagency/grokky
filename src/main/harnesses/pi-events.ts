import type { ProviderEvent } from "../providers/types";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function visibleText(messageValue: unknown): string {
  const message = record(messageValue);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.map((part) => record(part)?.type === "text" && typeof record(part)?.text === "string" ? record(part)!.text : "").join("").trim();
}

export class PiEventMapper {
  private responseText = "";
  private streamedText = "";
  private reasoningText = "";
  private errorText = "";

  map(value: unknown): ProviderEvent[] {
    const event = record(value);
    const type = typeof event?.type === "string" ? event.type : "";
    if (type === "message_update") {
      const update = record(event?.assistantMessageEvent);
      if (update?.type === "text_delta" && typeof update.delta === "string") {
        this.streamedText = `${this.streamedText}${update.delta}`.slice(-12_000);
        return [{ type: "activity", activity: { id: "pi-response", kind: "notice", label: "Pi is responding", detail: this.streamedText, status: "running", createdAt: Date.now() } }];
      }
      if (update?.type === "thinking_delta" && typeof update.delta === "string") {
        this.reasoningText = `${this.reasoningText}${update.delta}`.slice(-12_000);
        return [{ type: "activity", activity: { id: "pi-reasoning", kind: "reasoning", label: "Pi reasoning", detail: this.reasoningText, status: "running", createdAt: Date.now() } }];
      }
    }
    if (type === "message_end") {
      const message = record(event?.message);
      if (message?.stopReason === "error" && typeof message.errorMessage === "string") this.errorText = message.errorMessage.slice(0, 4_000);
      const text = visibleText(event?.message);
      if (text) this.responseText = text;
      const now = Date.now();
      return [
        ...(this.streamedText ? [{ type: "activity" as const, activity: { id: "pi-response", kind: "notice" as const, label: "Pi response complete", detail: this.responseText || this.streamedText, status: "completed" as const, createdAt: now } }] : []),
        ...(this.reasoningText ? [{ type: "activity" as const, activity: { id: "pi-reasoning", kind: "reasoning" as const, label: "Pi reasoning complete", detail: this.reasoningText, status: "completed" as const, createdAt: now } }] : []),
      ];
    }
    if (type === "tool_execution_start" && typeof event?.toolCallId === "string") {
      return [{ type: "activity", activity: { id: event.toolCallId, kind: "tool", label: `Pi tool: ${String(event.toolName || "tool")}`, status: "running", createdAt: Date.now() } }];
    }
    if (type === "tool_execution_end" && typeof event?.toolCallId === "string") {
      return [{ type: "activity", activity: { id: event.toolCallId, kind: "tool", label: `Pi tool: ${String(event.toolName || "tool")}`, status: event.isError ? "failed" : "completed", createdAt: Date.now() } }];
    }
    return [];
  }

  finalText(fallback?: string): string {
    return this.responseText || fallback || this.streamedText;
  }

  failureDetail(): string | undefined {
    return this.errorText || undefined;
  }
}
