import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ComputerToolName } from "../computer-access";
import type { ProviderRunContext } from "../providers/types";

const result = (text: string) => ({ content: [{ type: "text" as const, text: text.slice(0, 40_000) }], details: {} });
const controlKey = (id: string) => `pi:${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;

function computerTool(
  context: ProviderRunContext,
  name: ComputerToolName,
  label: string,
  description: string,
  parameters: ToolDefinition["parameters"],
  readOnly: boolean,
): ToolDefinition {
  return {
    name, label, description, parameters,
    execute: async (_id, params) => result(await context.executeTool(name, params as Record<string, unknown>, { readOnly })),
  };
}

export function createPiTools(context: ProviderRunContext): ToolDefinition[] {
  const access = context.computerAccess;
  const tools: ToolDefinition[] = [];
  if (access.enabled && access.grants.files !== "blocked") {
    tools.push(
      computerTool(context, "list_files", "List files", "List readable files inside the leased workspace.", Type.Object({}, { additionalProperties: false }), true),
      computerTool(context, "search_files", "Search files", "Search readable workspace files for literal text.", Type.Object({ query: Type.String() }, { additionalProperties: false }), true),
      computerTool(context, "read_file", "Read file", "Read one UTF-8 file relative to the leased workspace.", Type.Object({ path: Type.String() }, { additionalProperties: false }), true),
    );
    if (context.conversation.sandboxMode === "workspace-write") {
      tools.push(
        computerTool(context, "create_file", "Create file", "Create a new UTF-8 file inside the leased workspace.", Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false }), false),
        computerTool(context, "edit_file", "Edit file", "Replace one unique exact string inside a workspace file.", Type.Object({ path: Type.String(), old_text: Type.String(), new_text: Type.String() }, { additionalProperties: false }), false),
      );
    }
  }
  if (access.enabled && access.grants.commands !== "blocked" && context.conversation.sandboxMode === "workspace-write" && context.conversation.allowCommands) {
    tools.push(computerTool(context, "run_command", "Run command", "Run one PuckBot-allowlisted development command in the leased workspace.", Type.Object({ command: Type.String() }, { additionalProperties: false }), false));
  }
  if (access.enabled && access.grants.browser !== "blocked") {
    tools.push(computerTool(context, "browse_url", "Browse URL", "Read one approved public HTTP or HTTPS page.", Type.Object({ url: Type.String() }, { additionalProperties: false }), true));
  }
  if (access.enabled && access.grants.screen !== "blocked") {
    tools.push(computerTool(context, "capture_screen", "Capture screen", "Capture the current display after PuckBot access approval.", Type.Object({}, { additionalProperties: false }), true));
  }
  if (access.enabled && access.grants.automation !== "blocked" && context.conversation.sandboxMode === "workspace-write") {
    tools.push(
      computerTool(context, "open_application", "Open application", "Open a named desktop application after PuckBot access approval.", Type.Object({ name: Type.String() }, { additionalProperties: false }), false),
      computerTool(context, "click_screen", "Click screen", "Click a screen coordinate after inspecting current visible state.", Type.Object({ x: Type.Integer(), y: Type.Integer() }, { additionalProperties: false }), false),
      computerTool(context, "type_text", "Type text", "Type text into the active application after PuckBot access approval.", Type.Object({ text: Type.String() }, { additionalProperties: false }), false),
    );
  }
  if (context.controlTask) {
    tools.push({
      name: "task_control", label: "Task control", description: "Pause, resume, stop, reprioritize, redirect, or send a follow-up to a durable PuckBot task.",
      parameters: Type.Object({ task_id: Type.String(), action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("stop"), Type.Literal("reprioritize"), Type.Literal("redirect"), Type.Literal("follow-up")]), message: Type.Optional(Type.String()), priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })) }, { additionalProperties: false }),
      execute: async (id, params) => {
        const input = params as { task_id: string; action: "pause" | "resume" | "stop" | "reprioritize" | "redirect" | "follow-up"; message?: string; priority?: number };
        await context.controlTask!(input.task_id, { type: input.action, ...(input.message ? { message: input.message } : {}), ...(input.priority !== undefined ? { priority: input.priority } : {}), idempotencyKey: controlKey(id) });
        return result("Task control command accepted by PuckBot.");
      },
    }, {
      name: "agent_message", label: "Message agent", description: "Send a durable message to the harness currently assigned to a PuckBot task.",
      parameters: Type.Object({ task_id: Type.String(), message: Type.String() }, { additionalProperties: false }),
      execute: async (id, params) => {
        const input = params as { task_id: string; message: string };
        await context.controlTask!(input.task_id, { type: "message", message: input.message, idempotencyKey: controlKey(id) });
        return result("Agent message accepted by PuckBot.");
      },
    });
  }
  return tools;
}
