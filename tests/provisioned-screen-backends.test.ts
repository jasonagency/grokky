import { describe, expect, test } from "vitest";
import { CdpBrowserBackend, type CdpTransport } from "../src/runner/cdp-browser-backend";
import { ProvisionedDesktopBackend, type LinuxDesktopDriver } from "../src/runner/provisioned-desktop-backend";

describe("provisioned screen backends", () => {
  test("uses one persistent Chrome endpoint while isolating pages per agent", async () => {
    const commands: Array<{ pageId: string; method: string; params?: unknown }> = [];
    let pages = 0;
    const transport: CdpTransport = {
      verify: async () => undefined,
      openPage: async () => ({ id: `page-${++pages}`, webSocketDebuggerUrl: `ws://127.0.0.1/page-${pages}` }),
      command: async (page, method, params) => { commands.push({ pageId: page.id, method, params }); return method === "Page.captureScreenshot" ? { data: "cG5n" } : {}; },
      closePage: async () => undefined,
    };
    const backend = new CdpBrowserBackend("http://127.0.0.1:9222", transport);
    const context = await backend.createPersistentContext("shared");
    const first = await backend.openPage(context); const second = await backend.openPage(context);
    await expect(backend.screenshot(first)).resolves.toEqual({ mediaType: "image/png", data: "cG5n" });
    await backend.input(second, { type: "click", x: 10, y: 20 });
    expect(first).not.toBe(second);
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ pageId: first, method: "Page.captureScreenshot" }),
      expect.objectContaining({ pageId: second, method: "Input.dispatchMouseEvent" }),
    ]));
  });

  test("leases only explicitly provisioned non-root Linux displays", async () => {
    const actions: Array<{ display: string; input: unknown }> = [];
    const driver: LinuxDesktopDriver = {
      capture: async (display) => ({ mediaType: "image/png", data: Buffer.from(display).toString("base64") }),
      input: async (display, input) => { actions.push({ display, input }); },
    };
    const backend = new ProvisionedDesktopBackend([":21", ":22"], driver, () => 501);
    const first = await backend.createSession("agent:a"); const second = await backend.createSession("agent:b");
    await expect(backend.createSession("agent:c")).rejects.toThrow("No provisioned Linux desktop display");
    await backend.input(second, { type: "key", key: "Enter" });
    await backend.closeSession(first);
    await expect(backend.createSession("agent:c")).resolves.toBeTruthy();
    expect(actions).toEqual([{ display: ":22", input: { type: "key", key: "Enter" } }]);
  });

  test("refuses desktop automation when the runner is root", () => {
    expect(() => new ProvisionedDesktopBackend([":21"], { capture: async () => ({ mediaType: "image/png", data: "" }), input: async () => undefined }, () => 0)).toThrow("non-root");
  });
});
