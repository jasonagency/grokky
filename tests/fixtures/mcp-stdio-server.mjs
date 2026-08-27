import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

serveStdio(() => {
  const server = new McpServer({ name: "grokky-stdio-fixture", version: "1.0.0" });
  server.registerTool(
    "fixture_lookup",
    {
      description: "Look up fixture text",
      inputSchema: z.object({ q: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ q }) => ({ content: [{ type: "text", text: `stdio:${q}` }] }),
  );
  return server;
});
