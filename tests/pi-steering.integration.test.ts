import { describe, expect, test, vi } from "vitest";
import { PiAdapter } from "../src/main/harnesses/pi-adapter";
import { FakePiSession, piContext } from "./fixtures/pi-fixtures";

describe("Pi steering", () => {
  test("delivers redirect, deferred follow-up, and stop through distinct SDK methods", async () => {
    const session = new FakePiSession();
    let release!: () => void;
    session.prompt = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const adapter = new PiAdapter("/tmp", async () => session);
    const running = adapter.run(piContext());
    await vi.waitFor(() => expect(session.listeners).toHaveLength(1));
    expect((await adapter.deliverControl({ type: "steer", message: "redirect", sessionId: session.sessionFile })).accepted).toBe(true);
    expect((await adapter.deliverControl({ type: "follow-up", message: "later", sessionId: session.sessionFile })).accepted).toBe(true);
    expect((await adapter.deliverControl({ type: "cancel", sessionId: session.sessionFile })).accepted).toBe(true);
    expect(session.steer).toHaveBeenCalledWith("redirect");
    expect(session.followUp).toHaveBeenCalledWith("later");
    expect(session.abort).toHaveBeenCalledOnce();
    for (const listener of session.listeners) listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Stopped" }] } });
    release();
    await running;
  });
});
