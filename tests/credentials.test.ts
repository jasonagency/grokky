import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { defaultOpenRouterCredentialCandidates, isUsableOpenRouterKey, parseEnvValue } from "../src/main/credentials";

describe("credential parsing", () => {
  test("reads a quoted OpenRouter key without returning adjacent values", () => {
    const source = [
      "# local settings",
      "OTHER_KEY=not-this-one",
      "export OPENROUTER_API_KEY=\"sk-or-v1-test-value\"",
      "TRAILING=value",
    ].join("\n");
    expect(parseEnvValue(source, "OPENROUTER_API_KEY")).toBe("sk-or-v1-test-value");
  });

  test("ignores comments and missing values", () => {
    expect(parseEnvValue("# OPENROUTER_API_KEY=nope\nOTHER=1", "OPENROUTER_API_KEY")).toBeUndefined();
  });

  test("rejects inherited placeholder keys", () => {
    expect(isUsableOpenRouterKey("sk-or-REPLACE_ME")).toBe(false);
    expect(isUsableOpenRouterKey(`sk-or-v1-${"a".repeat(40)}`)).toBe(true);
  });

  test("uses portable default credential locations", () => {
    const previousPuckBot = process.env.PUCKBOT_OPENROUTER_ENV_FILE;
    const previousGrokky = process.env.GROKKY_OPENROUTER_ENV_FILE;
    delete process.env.PUCKBOT_OPENROUTER_ENV_FILE;
    delete process.env.GROKKY_OPENROUTER_ENV_FILE;
    try {
      expect(defaultOpenRouterCredentialCandidates("/home/example")).toEqual([
        join("/home/example", ".config", "puckbot", ".env"),
        join("/home/example", ".config", "grokky", ".env"),
      ]);
    } finally {
      if (previousPuckBot === undefined) delete process.env.PUCKBOT_OPENROUTER_ENV_FILE;
      else process.env.PUCKBOT_OPENROUTER_ENV_FILE = previousPuckBot;
      if (previousGrokky === undefined) delete process.env.GROKKY_OPENROUTER_ENV_FILE;
      else process.env.GROKKY_OPENROUTER_ENV_FILE = previousGrokky;
    }
  });

  test("prefers the PuckBot env-file override while retaining the legacy alias", () => {
    const previousPuckBot = process.env.PUCKBOT_OPENROUTER_ENV_FILE;
    const previousGrokky = process.env.GROKKY_OPENROUTER_ENV_FILE;
    process.env.PUCKBOT_OPENROUTER_ENV_FILE = "/credentials/puckbot.env";
    process.env.GROKKY_OPENROUTER_ENV_FILE = "/credentials/grokky.env";
    try {
      expect(defaultOpenRouterCredentialCandidates("/home/example")).toEqual([
        "/credentials/puckbot.env",
        "/credentials/grokky.env",
        join("/home/example", ".config", "puckbot", ".env"),
        join("/home/example", ".config", "grokky", ".env"),
      ]);
    } finally {
      if (previousPuckBot === undefined) delete process.env.PUCKBOT_OPENROUTER_ENV_FILE;
      else process.env.PUCKBOT_OPENROUTER_ENV_FILE = previousPuckBot;
      if (previousGrokky === undefined) delete process.env.GROKKY_OPENROUTER_ENV_FILE;
      else process.env.GROKKY_OPENROUTER_ENV_FILE = previousGrokky;
    }
  });
});
