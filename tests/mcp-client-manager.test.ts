import { describe, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import type { McpServerConfiguration } from "../src/main/capabilities";
import { McpAuthManager } from "../src/main/tools/mcp-auth";
import { connectMcpClient, McpClientManager, type McpClientLike } from "../src/main/tools/mcp-client-manager";

const configuration: McpServerConfiguration = {
  id: "fixture",
  enabled: true,
  transport: "streamable-http",
  url: "https://mcp.example/mcp",
  timeoutMs: 1_000,
};

function client(tools: Tool[], result: CallToolResult = { content: [{ type: "text", text: "fixture result" }] }) {
  const value: McpClientLike = {
    listTools: vi.fn(async () => ({ tools })),
    callTool: vi.fn(async () => result),
    close: vi.fn(async () => undefined),
  };
  return value;
}

describe("MCP client manager", () => {
  test("connects to real fake stdio and Streamable HTTP servers", async () => {
    const stdio = await connectMcpClient({
      id: "stdio", enabled: true, transport: "stdio", command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url))], timeoutMs: 5_000,
    }, new McpAuthManager());
    expect((await stdio.listTools()).tools.map((tool) => tool.name)).toContain("fixture_lookup");
    expect(JSON.stringify(await stdio.callTool({ name: "fixture_lookup", arguments: { q: "ok" } }))).toContain("stdio:ok");
    await stdio.close();

    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "grokky-http-fixture", version: "1.0.0" });
      server.registerTool("fixture_lookup", { inputSchema: z.object({ q: z.string() }), annotations: { readOnlyHint: true } }, async ({ q }) => ({ content: [{ type: "text", text: `http:${q}` }] }));
      return server;
    }, { responseMode: "json" });
    const http = createServer(toNodeHandler(handler));
    await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
    try {
      const address = http.address();
      if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind");
      const remote = await connectMcpClient({ id: "http", enabled: true, transport: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp`, timeoutMs: 5_000 }, new McpAuthManager());
      expect((await remote.listTools()).tools.map((tool) => tool.name)).toContain("fixture_lookup");
      expect(JSON.stringify(await remote.callTool({ name: "fixture_lookup", arguments: { q: "ok" } }))).toContain("http:ok");
      await remote.close();
    } finally {
      await handler.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }, 20_000);

  test("discovers stable names and executes the original server tool", async () => {
    const sdk = client([{ name: "search docs", description: "Search", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, annotations: { readOnlyHint: true } }]);
    const manager = new McpClientManager(new McpAuthManager(), async () => sdk);
    const discovered = await manager.discover([configuration]);
    expect(discovered[0]?.status).toBe("ready");
    const tool = discovered[0]?.tools[0];
    expect(tool?.namespacedName).toMatch(/^mcp_fixture_search_docs_[a-f0-9]{8}$/);
    await expect(manager.call(configuration, tool!.namespacedName, { q: "MCP" }, new AbortController().signal)).resolves.toBe("fixture result");
    expect(sdk.callTool).toHaveBeenCalledWith(
      { name: "search docs", arguments: { q: "MCP" } },
      expect.objectContaining({ timeout: 1_000, maxTotalTimeout: 1_000 }),
    );
  });

  test("rejects malicious recursive and oversized schemas before exposure", async () => {
    const recursive = client([{ name: "recursive", inputSchema: { type: "object", properties: { value: { $ref: "#" } } } }]);
    const manager = new McpClientManager(new McpAuthManager(), async () => recursive);
    const result = await manager.discover([configuration]);
    expect(result[0]).toMatchObject({ status: "error", tools: [] });
    expect(result[0]?.detail).toContain("$ref");
    expect(recursive.close).toHaveBeenCalledOnce();

    const huge = client([{ name: "huge", inputSchema: { type: "object", description: "x".repeat(30_000) } }]);
    const second = new McpClientManager(new McpAuthManager(), async () => huge);
    expect((await second.discover([configuration]))[0]?.detail).toContain("24 KB");
  });

  test("drops a disconnected client so the next call reconnects", async () => {
    const first = client([{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }]);
    first.callTool = vi.fn(async () => { throw new Error("transport disconnected"); });
    const second = client([{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }]);
    const connector = vi.fn(async () => connector.mock.calls.length === 1 ? first : second);
    const manager = new McpClientManager(new McpAuthManager(), connector);
    const tool = (await manager.discover([configuration]))[0]!.tools[0]!;
    await expect(manager.call(configuration, tool.namespacedName, {}, new AbortController().signal)).rejects.toThrow("disconnected");
    await expect(manager.call(configuration, tool.namespacedName, {}, new AbortController().signal)).resolves.toBe("fixture result");
    expect(connector).toHaveBeenCalledTimes(2);
  });

  test("propagates abort and caps oversized server output", async () => {
    const aborting = client([{ name: "slow", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }]);
    aborting.callTool = vi.fn(async (_params, options) => new Promise<CallToolResult>((_resolve, reject) => {
      if (options?.signal?.aborted) { reject(new Error("aborted")); return; }
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const manager = new McpClientManager(new McpAuthManager(), async () => aborting);
    const tool = (await manager.discover([configuration]))[0]!.tools[0]!;
    const controller = new AbortController();
    const pending = manager.call(configuration, tool.namespacedName, {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");

    const oversized = client([{ name: "large", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }], { content: [{ type: "text", text: "x".repeat(80_000) }] });
    const second = new McpClientManager(new McpAuthManager(), async () => oversized);
    const largeTool = (await second.discover([{ ...configuration, id: "large" }]))[0]!.tools[0]!;
    await expect(second.call({ ...configuration, id: "large" }, largeTool.namespacedName, {}, new AbortController().signal)).resolves.toHaveLength(40_000);
  });

  test("coalesces concurrent connection attempts for the same server", async () => {
    const sdk = client([{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }]);
    let release!: () => void;
    const connector = vi.fn(() => new Promise<McpClientLike>((resolve) => { release = () => resolve(sdk); }));
    const manager = new McpClientManager(new McpAuthManager(), connector);
    const first = manager.discover([configuration]);
    const second = manager.discover([configuration]);
    await vi.waitFor(() => expect(connector).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(connector).toHaveBeenCalledTimes(1);
  });
});
