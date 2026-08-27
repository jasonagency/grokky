import { describe, expect, test, vi } from "vitest";
import { BrowserSessionBroker } from "../src/runner/browser-session-broker";
import { BrowserScreenProvider } from "../src/runner/browser-screen-provider";
import { ScreenSessionManager } from "../src/runner/screen-session-manager";

describe("BrowserSessionBroker", () => {
  test("shares one approved-login context while assigning distinct pages to concurrent agents", async () => {
    let page = 0; const createPersistentContext = vi.fn(async () => "shared-context"); const openPage = vi.fn(async () => `page-${++page}`);
    const broker = new BrowserSessionBroker({ createPersistentContext, openPage, screenshot: async (pageId) => ({ mediaType: "image/png", data: pageId }), input: async () => undefined, closePage: async () => undefined });
    const manager = new ScreenSessionManager([new BrowserScreenProvider(broker)]);
    const [first, second] = await Promise.all([manager.lease("agent:a", "browser"), manager.lease("agent:b", "browser")]);
    expect(createPersistentContext).toHaveBeenCalledOnce(); expect(openPage).toHaveBeenCalledTimes(2); expect(first.providerSessionId).not.toBe(second.providerSessionId);
    expect((await manager.capture(first.id, first.epoch)).data).toBe("page-1");
    expect((await manager.capture(second.id, second.epoch)).data).toBe("page-2");
  });
});
