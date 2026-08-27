import { describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiAdapter } from "../src/main/harnesses/pi-adapter";
import { FakePiSession, piContext } from "./fixtures/pi-fixtures";

describe("Pi session recovery", () => {
  test("opens a real persisted Pi session fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokky-pi-session-"));
    const manager = SessionManager.create(root, join(root, "sessions"));
    manager.appendMessage({ role: "user", content: "Persist me", timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Persisted" }], api: "google-generative-ai", provider: "google", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
    const sessionFile = manager.getSessionFile();
    expect(sessionFile).toBeTruthy();
    const restored = SessionManager.open(sessionFile!, join(root, "sessions"), root);
    expect(restored.buildSessionContext().messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: "Persist me" })]));
  });

  test("passes the persisted native session file back to the SDK after restart", async () => {
    const existing = "/tmp/pi-sessions/existing.jsonl";
    let received: string | undefined;
    const session = new FakePiSession();
    session.sessionFile = existing;
    await new PiAdapter("/tmp", async (_context, sessionReference) => { received = sessionReference; return session; }).run(piContext([], existing));
    expect(received).toBe(existing);
  });
});
