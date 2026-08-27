import { describe, expect, test, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/client";
import type { McpServerConfiguration } from "../src/main/capabilities";
import { McpAuthManager } from "../src/main/tools/mcp-auth";
import { McpClientManager, type McpClientLike } from "../src/main/tools/mcp-client-manager";
import { ToolGateway } from "../src/main/tools/tool-gateway";

const configuration: McpServerConfiguration = { id: "research", enabled: true, transport: "stdio", command: "fixture", timeoutMs: 5_000 };

function gateway(tools: Tool[]) {
  const sdk: McpClientLike = {
    listTools: vi.fn(async () => ({ tools })),
    callTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }] })),
    close: vi.fn(async () => undefined),
  };
  return { gateway: new ToolGateway(new McpClientManager(new McpAuthManager(), async () => sdk)), sdk };
}

describe("MCP tool gateway", () => {
  test("defaults unclassified tools to external side effect and withholds them from specialists", async () => {
    const fixture = gateway([{ name: "unknown", description: "No annotations", inputSchema: { type: "object" } }]);
    const prepared = await fixture.gateway.prepare([configuration]);
    const tool = prepared.tools[0]!;
    expect(tool).toMatchObject({ classification: "external-side-effect", classificationSource: "safe-default" });
    await expect(fixture.gateway.execute({
      configurations: [configuration], name: tool.name, args: {}, readOnly: true,
      signal: new AbortController().signal, authorize: vi.fn(async () => undefined),
    })).rejects.toThrow("Read-only specialists");
    expect(fixture.sdk.callTool).not.toHaveBeenCalled();
  });

  test("executes an explicitly read-only tool through authorization and caps output", async () => {
    const fixture = gateway([{ name: "lookup", description: "Read facts", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }]);
    const tool = (await fixture.gateway.prepare([configuration])).tools[0]!;
    const authorize = vi.fn(async () => undefined);
    await expect(fixture.gateway.execute({
      configurations: [configuration], name: tool.name, args: {}, readOnly: true,
      signal: new AbortController().signal, authorize,
    })).resolves.toBe("done");
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ classification: "read", serverId: "research" }));
  });

  test("operator human-only policy always denies model execution", async () => {
    const fixture = gateway([{ name: "delete_everything", inputSchema: { type: "object" } }]);
    const initial = (await fixture.gateway.prepare([configuration])).tools[0]!;
    const policies = { [initial.name]: "human-only" as const };
    const tool = (await fixture.gateway.prepare([configuration], policies)).tools[0]!;
    await expect(fixture.gateway.execute({
      configurations: [configuration], policies, name: tool.name, args: {}, readOnly: false,
      signal: new AbortController().signal, authorize: vi.fn(async () => undefined),
    })).rejects.toThrow("direct human use");
  });
});
