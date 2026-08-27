import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/client";
import type { McpToolClassification, McpToolCapability } from "../../shared/contracts";

const MAX_SCHEMA_BYTES = 24_000;
const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_NODES = 500;
const FORBIDDEN_SCHEMA_KEYS = new Set(["$ref", "$defs", "definitions", "unevaluatedProperties"]);

function safePart(value: string, limit: number): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, limit) || "tool";
}

export function namespacedMcpToolName(serverId: string, toolName: string): string {
  const digest = createHash("sha256").update(`${serverId}\0${toolName}`).digest("hex").slice(0, 8);
  return `mcp_${safePart(serverId, 18)}_${safePart(toolName, 26)}_${digest}`.slice(0, 64);
}

export function boundedToolSchema(value: unknown): Record<string, unknown> {
  const encoded = JSON.stringify(value ?? {});
  if (Buffer.byteLength(encoded, "utf8") > MAX_SCHEMA_BYTES) throw new Error("MCP tool schema exceeds the 24 KB limit");
  const seen = new WeakSet<object>();
  let nodes = 0;

  const visit = (input: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES) throw new Error("MCP tool schema is too complex");
    if (depth > MAX_SCHEMA_DEPTH) throw new Error("MCP tool schema is too deeply nested");
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new Error("MCP tool schema contains a non-finite number");
      return input;
    }
    if (Array.isArray(input)) {
      if (input.length > 100) throw new Error("MCP tool schema contains an oversized array");
      return input.map((item) => visit(item, depth + 1));
    }
    if (!input || typeof input !== "object") throw new Error("MCP tool schema contains an unsupported value");
    if (seen.has(input)) throw new Error("MCP tool schema recursion is unsupported");
    seen.add(input);
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length > 100) throw new Error("MCP tool schema object has too many fields");
    const output: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      if (FORBIDDEN_SCHEMA_KEYS.has(key)) throw new Error(`MCP tool schema keyword ${key} is unsupported`);
      if (key.length > 120) throw new Error("MCP tool schema contains an oversized key");
      output[key] = visit(item, depth + 1);
    }
    seen.delete(input);
    return output;
  };

  const schema = visit(value ?? {}, 0);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("MCP tool input schema must be an object");
  const result = schema as Record<string, unknown>;
  if (result.type !== undefined && result.type !== "object") throw new Error("MCP tool input schema root must have object type");
  return { type: "object", ...result, additionalProperties: result.additionalProperties === true };
}

export function classifyMcpTool(
  serverId: string,
  tool: Tool,
  policies: Record<string, McpToolClassification> = {},
): McpToolCapability {
  const namespacedName = namespacedMcpToolName(serverId, tool.name);
  const operator = policies[namespacedName];
  if (operator) {
    return {
      name: tool.name,
      namespacedName,
      description: (tool.description || tool.name).slice(0, 1_000),
      classification: operator,
      classificationSource: "operator",
    };
  }
  const annotations = tool.annotations;
  const classification: McpToolClassification = annotations?.readOnlyHint === true
    ? "read"
    : annotations && (annotations.destructiveHint === false && annotations.openWorldHint === false)
      ? "write"
      : "external-side-effect";
  return {
    name: tool.name,
    namespacedName,
    description: (tool.description || tool.name).slice(0, 1_000),
    classification,
    classificationSource: annotations ? "server-annotation" : "safe-default",
  };
}
