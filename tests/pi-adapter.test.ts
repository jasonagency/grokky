import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { defaultPiSessionFactory, PiAdapter } from "../src/main/harnesses/pi-adapter";
import type { ProviderEvent } from "../src/main/providers/types";
import { FakePiSession, piContext } from "./fixtures/pi-fixtures";

describe("Pi native adapter", () => {
  test("normalizes streaming, tools, final response, usage, and persistent session", async () => {
    const events: ProviderEvent[] = [];
    const session = new FakePiSession();
    await new PiAdapter("/tmp", async () => session).run(piContext(events));
    expect(events).toContainEqual({ type: "thread", threadId: session.sessionFile });
    expect(events.filter((event) => event.type === "final")).toEqual([{ type: "final", text: "Pi answer" }]);
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 13, cachedInputTokens: 2, outputTokens: 4, costUsd: 0.002 } });
    expect(events.some((event) => event.type === "activity" && event.activity.id === "tool-1" && event.activity.status === "completed")).toBe(true);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  test("reports unavailable credentials without crashing", async () => {
    const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    keys.forEach((key) => delete process.env[key]);
    try {
      const adapter = new PiAdapter("/definitely/missing", async () => new FakePiSession());
      const status = await adapter.health();
      expect(status.ready).toBe(false);
      expect(status.label).toContain("missing");
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
    expect(events.filter((event) => event.type === "final")).toEqual([{ type: "final", text: expect.stringContaining("PI LIVE READY") }]);
    expect(events.some((event) => event.type === "usage" && event.usage.outputTokens > 0)).toBe(true);
    expect(events.some((event) => event.type === "activity" && event.activity.id === "pi-response")).toBe(true);
  }, 180_000);
});
