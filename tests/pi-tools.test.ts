import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createPiResourceLoader } from "../src/main/harnesses/pi-resources";
import { createPiTools } from "../src/main/harnesses/pi-tools";
import { piContext } from "./fixtures/pi-fixtures";

describe("Pi Grokky tools", () => {
  test("exposes no Pi built-ins and sends writes through Grokky access", async () => {
    const context = piContext();
    context.computerAccess.enabled = true;
    context.computerAccess.grants.files = "allow";
    const execute = vi.fn(async () => "created");
    context.executeTool = execute;
    const tools = createPiTools(context);
    expect(tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["bash", "write", "edit", "read"]));
    const create = tools.find((tool) => tool.name === "create_file")!;
    await create.execute("call", { path: "safe.txt", content: "hello" }, undefined, undefined, {} as never);
    expect(execute).toHaveBeenCalledWith("create_file", { path: "safe.txt", content: "hello" }, { readOnly: false });
  });

  test("read-only mode removes mutating tools regardless of profile", () => {
    const context = piContext();
    context.conversation.sandboxMode = "read-only";
    context.conversation.allowCommands = true;
    context.computerAccess.enabled = true;
    context.computerAccess.grants = { files: "allow", commands: "allow", browser: "allow", screen: "allow", automation: "allow", mcp: "allow" };
    const names = createPiTools(context).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["list_files", "read_file", "browse_url", "capture_screen"]));
    expect(names).not.toEqual(expect.arrayContaining(["create_file", "edit_file", "run_command", "open_application", "click_screen", "type_text"]));
  });

  test("excludes project extensions from the controlled resource loader", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "grokky-pi-resources-"));
    const extensionDirectory = join(cwd, ".pi", "extensions");
    await mkdir(extensionDirectory, { recursive: true });
    await writeFile(join(extensionDirectory, "unapproved.ts"), "export default (pi) => pi.registerTool({ name: 'unsafe' });\n");
    const loader = await createPiResourceLoader({ cwd, agentDir: join(cwd, "agent") });
    expect(loader.getExtensions().extensions).toEqual([]);
  });

  test("loads only skills explicitly selected by Grokky", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "grokky-pi-skills-"));
    const selectedDirectory = join(cwd, "selected");
    const unselectedDirectory = join(cwd, "unselected");
    await Promise.all([mkdir(selectedDirectory, { recursive: true }), mkdir(unselectedDirectory, { recursive: true })]);
    await Promise.all([
      writeFile(join(selectedDirectory, "SKILL.md"), "---\nname: selected\ndescription: Selected by Grokky\n---\nUse the selected skill.\n"),
      writeFile(join(unselectedDirectory, "SKILL.md"), "---\nname: unselected\ndescription: Not selected\n---\nDo not load this skill.\n"),
    ]);
    const loader = await createPiResourceLoader({
      cwd,
      agentDir: join(cwd, "agent"),
      selectedSkillPaths: [join(selectedDirectory, "SKILL.md")],
    });
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["selected"]);
  });
});
