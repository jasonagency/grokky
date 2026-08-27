import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CapabilitiesService } from "../src/main/capabilities";

describe("CapabilitiesService", () => {
  test("discovers and toggles skills, MCP servers, and connectors without replacing unrelated config", async () => {
    const home = await mkdtemp(join(tmpdir(), "grokky-capabilities-"));
    const skillDirectory = join(home, ".agents", "skills", "tiny-skill");
    const configPath = join(home, ".codex", "config.toml");
    await mkdir(skillDirectory, { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), [
      "---",
      "name: tiny-skill",
      "description: A small test workflow.",
      "---",
      "Do the tiny workflow.",
    ].join("\n"));
    await writeFile(configPath, [
      "model = \"gpt-5.6-sol\"",
      "",
      "[mcp_servers.docs]",
      "url = \"https://example.com/mcp\"",
      "bearer_token_env_var = \"MCP_DOCS_TOKEN\"",
      "",
      "[mcp_servers.local]",
      "command = \"node\"",
      "args = [\"server.mjs\"]",
      "",
      "[mcp_servers.local.env]",
      "FIXTURE_PRIVATE_VALUE = \"main-process-only\"",
      "",
      "[plugins.\"files@example\"]",
      "enabled = true",
      "",
    ].join("\n"));

    const service = new CapabilitiesService(home);
    const initial = await service.snapshot(home);
    expect(initial.skills.find((skill) => skill.name === "tiny-skill")?.enabled).toBe(true);
    expect(initial.mcpServers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "docs", enabled: true, transport: "remote" }),
      expect.objectContaining({ id: "local", enabled: true, transport: "local" }),
    ]));
    expect(JSON.stringify(initial)).not.toContain("main-process-only");
    const privateConfigurations = await service.mcpServerConfigurations();
    expect(privateConfigurations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "docs", bearerTokenEnvVar: "MCP_DOCS_TOKEN" }),
      expect.objectContaining({ id: "local", command: "node", args: ["server.mjs"], env: { FIXTURE_PRIVATE_VALUE: "main-process-only" } }),
    ]));
    expect(initial.connectors).toMatchObject([{ id: "files@example", enabled: true }]);

    const skillPath = join(skillDirectory, "SKILL.md");
    expect((await service.setSkillEnabled(skillPath, false, home)).skills.find((skill) => skill.name === "tiny-skill")?.enabled).toBe(false);
    expect((await service.setMcpEnabled("docs", false, home)).mcpServers.find((server) => server.id === "docs")?.enabled).toBe(false);
    expect((await service.setConnectorEnabled("files@example", false, home)).connectors[0]?.enabled).toBe(false);

    const config = await readFile(configPath, "utf8");
    expect(config).toContain("model = \"gpt-5.6-sol\"");
    expect(config).toContain(`path = ${JSON.stringify(skillPath)}`);
    expect(config.match(/enabled = false/g)?.length).toBe(3);
  });
});
