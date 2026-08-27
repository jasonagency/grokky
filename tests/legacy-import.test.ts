import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { StateStore } from "../src/main/state-store";

describe("legacy JSON import", () => {
  test("imports version 2 state once and retains a recoverable backup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-legacy-"));
    const legacyPath = join(directory, "conversations.json");
    const databasePath = join(directory, "control-plane.sqlite3");
    const legacy = {
      version: 2,
      activeConversationId: "legacy-chat",
      settings: { defaultWorkingDirectory: directory, theme: "dark" },
      computerAccess: { enabled: true },
      conversations: [{
        id: "legacy-chat",
        title: "Legacy chat",
        workingDirectory: directory,
        messages: [],
        activities: [],
        createdAt: 1,
        updatedAt: 2,
      }],
    };
    await writeFile(legacyPath, JSON.stringify(legacy));

    const first = new StateStore(databasePath, directory, { legacyPath });
    expect((await first.load()).conversations).toHaveLength(1);
    await first.close();

    await access(`${legacyPath}.legacy-v2-backup`);
    expect(JSON.parse(await readFile(`${legacyPath}.legacy-v2-backup`, "utf8"))).toMatchObject({ activeConversationId: "legacy-chat" });

    legacy.conversations.push({
      id: "second-chat",
      title: "Should not import",
      workingDirectory: directory,
      messages: [],
      activities: [],
      createdAt: 3,
      updatedAt: 4,
    });
    await writeFile(legacyPath, JSON.stringify(legacy));

    const reopened = new StateStore(databasePath, directory, { legacyPath });
    expect((await reopened.load()).conversations.map((conversation) => conversation.id)).toEqual(["legacy-chat"]);
    await reopened.close();
  });

  test("skips malformed optional records without dropping valid siblings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grokky-legacy-"));
    const legacyPath = join(directory, "conversations.json");
    await writeFile(legacyPath, JSON.stringify({
      version: 2,
      settings: { defaultWorkingDirectory: directory },
      conversations: [
        { id: "valid", title: "Valid", workingDirectory: directory, messages: [], activities: [], createdAt: 1, updatedAt: 1 },
        { id: 42, title: "Invalid" },
      ],
    }));

    const diagnostics: string[] = [];
    const store = new StateStore(join(directory, "control-plane.sqlite3"), directory, {
      legacyPath,
      onDiagnostic: (message) => diagnostics.push(message),
    });
    expect((await store.load()).conversations.map((conversation) => conversation.id)).toEqual(["valid"]);
    expect(diagnostics).toEqual(["Skipped 1 invalid legacy conversation record."]);
    await store.close();
  });
});
