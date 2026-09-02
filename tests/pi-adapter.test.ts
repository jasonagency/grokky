import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { capPiModelOutputTokens, defaultPiSessionFactory, PiAdapter, preferredAutomaticPiModel } from "../src/main/harnesses/pi-adapter";
import type { ProviderEvent } from "../src/main/providers/types";
import { FakePiSession, piContext } from "./fixtures/pi-fixtures";

describe("Pi native adapter", () => {
  test("normalizes streaming, tools, final response, usage, and persistent session", async () => {
    const events: ProviderEvent[] = [];
    const session = new FakePiSession();
    session.model = { provider: "openrouter", id: "openai/gpt-5.2" };
    await new PiAdapter("/tmp", async () => session).run(piContext(events));
    expect(events).toContainEqual({ type: "thread", threadId: session.sessionFile });
    expect(events.filter((event) => event.type === "final")).toEqual([{ type: "final", text: "Pi answer", runtime: expect.objectContaining({ requestedModel: "anthropic/claude-sonnet-4-6", resolvedModel: "openrouter/openai/gpt-5.2" }) }]);
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 13, cachedInputTokens: 2, outputTokens: 4, costUsd: 0.002 } });
    expect(events.some((event) => event.type === "activity" && event.activity.id === "tool-1" && event.activity.status === "completed")).toBe(true);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  test("automatic model selection prefers the configured OpenRouter route", () => {
    const selected = preferredAutomaticPiModel([
      { provider: "google", id: "gemini-2.5-flash" },
      { provider: "openrouter", id: "anthropic/claude-sonnet-4.6" },
      { provider: "openrouter", id: "openai/gpt-5.2" },
    ]);

    expect(selected).toEqual({ provider: "openrouter", id: "openai/gpt-5.2" });
  });

  test("automatic model selection falls back to another OpenRouter model, then any available model", () => {
    expect(preferredAutomaticPiModel([
      { provider: "google", id: "gemini-2.5-flash" },
      { provider: "openrouter", id: "anthropic/claude-sonnet-4.6" },
    ])).toEqual({ provider: "openrouter", id: "anthropic/claude-sonnet-4.6" });
    expect(preferredAutomaticPiModel([{ provider: "google", id: "gemini-2.5-flash" }]))
      .toEqual({ provider: "google", id: "gemini-2.5-flash" });
    expect(preferredAutomaticPiModel([])).toBeUndefined();
  });

  test("caps oversized model output allowances without changing smaller limits", () => {
    const oversized = { provider: "openrouter", id: "openai/gpt-5.2", maxTokens: 128_000, contextWindow: 400_000 };
    const smaller = { provider: "openrouter", id: "example/small", maxTokens: 8_192 };

    expect(capPiModelOutputTokens(oversized)).toEqual({ ...oversized, maxTokens: 16_384 });
    expect(capPiModelOutputTokens(smaller)).toBe(smaller);
  });

  test("reports unavailable credentials without crashing", async () => {
    const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    keys.forEach((key) => delete process.env[key]);
    try {
      const adapter = new PiAdapter("/definitely/missing", async () => new FakePiSession());
      const settings = piContext().settings;
      const status = await adapter.health({ settings, homeDirectory: "/definitely/missing" });
      expect(status.ready).toBe(false);
      expect(status.label).toContain("missing");
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  test("accepts PuckBot's configured OpenRouter credential for Pi readiness", async () => {
    const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    keys.forEach((key) => delete process.env[key]);
    const directory = await mkdtemp(join(tmpdir(), "puckbot-pi-health-"));
    const credentialPath = join(directory, "openrouter.env");
    await writeFile(credentialPath, `OPENROUTER_API_KEY=sk-or-v1-${"a".repeat(32)}\n`);
    const settings = piContext().settings;
    settings.openRouterCredentialPath = credentialPath;

    try {
      const status = await new PiAdapter(directory, async () => new FakePiSession()).health({ settings, homeDirectory: directory });
      expect(status).toMatchObject({ ready: true, source: credentialPath });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});

describe.skipIf(process.env.GROKKY_LIVE_PI !== "1")("live Pi native adapter", () => {
  test("streams one final answer and usage through a persistent native session", async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), "grokky-pi-live-"));
    const events: ProviderEvent[] = [];
    const context = piContext(events);
    context.conversation.model = process.env.GROKKY_PI_SMOKE_MODEL || "google/gemini-3-flash-preview";
    context.prompt = "Reply with exactly PI LIVE READY.";
    await new PiAdapter(homedir(), defaultPiSessionFactory(homedir(), sessionRoot)).run(context);
    expect(events.filter((event) => event.type === "thread")).toHaveLength(1);
    expect(events.filter((event) => event.type === "final")).toEqual([expect.objectContaining({
      type: "final",
      text: expect.stringContaining("PI LIVE READY"),
      runtime: expect.objectContaining({ requestedModel: context.conversation.model, resolvedModel: expect.any(String) }),
    })]);
    expect(events.some((event) => event.type === "usage" && event.usage.outputTokens > 0)).toBe(true);
    expect(events.some((event) => event.type === "activity" && event.activity.id === "pi-response")).toBe(true);
  }, 180_000);
});
