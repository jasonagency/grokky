import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { preparePuckBotUserDataDirectory, resolveUserDataOverride } from "../src/main/app-identity";

describe("PuckBot application identity", () => {
  test("moves an existing Grokky user-data directory to PuckBot", async () => {
    const appData = await mkdtemp(join(tmpdir(), "puckbot-identity-"));
    const legacyDirectory = join(appData, "Grokky");
    await mkdir(legacyDirectory);
    await writeFile(join(legacyDirectory, "conversations.sqlite3"), "existing-data");

    const result = preparePuckBotUserDataDirectory(appData);

    expect(result).toEqual({ path: join(appData, "PuckBot"), migrated: true });
    await expect(readFile(join(result.path, "conversations.sqlite3"), "utf8")).resolves.toBe("existing-data");
  });

  test("keeps the explicit user-data override for compatibility", async () => {
    const appData = await mkdtemp(join(tmpdir(), "puckbot-identity-"));
    const override = join(appData, "custom-state");

    expect(preparePuckBotUserDataDirectory(appData, override)).toEqual({ path: override, migrated: false });
  });

  test("prefers the new user-data override and falls back from an empty value", () => {
    expect(resolveUserDataOverride("/state/puckbot", "/state/grokky")).toBe("/state/puckbot");
    expect(resolveUserDataOverride("", "/state/grokky")).toBe("/state/grokky");
    expect(resolveUserDataOverride("   ", "")).toBeUndefined();
  });

  test("does not overwrite an existing PuckBot directory", async () => {
    const appData = await mkdtemp(join(tmpdir(), "puckbot-identity-"));
    await mkdir(join(appData, "Grokky"));
    await mkdir(join(appData, "PuckBot"));

    expect(preparePuckBotUserDataDirectory(appData)).toEqual({ path: join(appData, "PuckBot"), migrated: false });
  });
});
