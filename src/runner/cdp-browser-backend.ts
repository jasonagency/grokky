import type { ScreenInput } from "../shared/remote-protocol";
import type { BrowserBackend } from "./browser-session-broker";

interface CdpPage { id: string; webSocketDebuggerUrl: string }
export interface CdpTransport {
  verify(endpoint: string): Promise<void>;
  openPage(endpoint: string): Promise<CdpPage>;
  command(page: CdpPage, method: string, params?: unknown): Promise<Record<string, unknown>>;
  closePage(endpoint: string, pageId: string): Promise<void>;
}

function endpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname) || url.username || url.password) {
    throw new Error("Chrome DevTools must listen on a credential-free loopback HTTP endpoint");
  }
  return url.toString().replace(/\/$/, "");
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
  try { const response = await fetch(url, { ...init, signal: controller.signal }); if (!response.ok) throw new Error(`Chrome DevTools returned HTTP ${response.status}`); return await response.json() as T; }
  finally { clearTimeout(timer); }
}

class WebSocketCdpTransport implements CdpTransport {
  async verify(value: string): Promise<void> {
    const result = await fetchJson<{ Browser?: string; webSocketDebuggerUrl?: string }>(`${value}/json/version`);
    if (!result.Browser || !result.webSocketDebuggerUrl) throw new Error("Chrome DevTools endpoint is unavailable or incomplete");
  }
  async openPage(value: string): Promise<CdpPage> {
    const page = await fetchJson<Partial<CdpPage>>(`${value}/json/new?about%3Ablank`, { method: "PUT" });
    if (!page.id || !page.webSocketDebuggerUrl) throw new Error("Chrome DevTools did not create an addressable page");
    return page as CdpPage;
  }
  command(page: CdpPage, method: string, params?: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolvePromise, reject) => {
      const socket = new WebSocket(page.webSocketDebuggerUrl); const id = 1;
      let settled = false;
      const finish = (error?: Error, result?: Record<string, unknown>) => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); if (error) reject(error); else resolvePromise(result ?? {}); };
      const timer = setTimeout(() => finish(new Error(`Chrome DevTools command ${method} timed out`)), 15_000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })));
      socket.addEventListener("message", (event) => {
        const response = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        if (response.id !== id) return;
        if (response.error) finish(new Error(response.error.message || `Chrome DevTools command ${method} failed`));
        else finish(undefined, response.result);
      });
      socket.addEventListener("error", () => finish(new Error("Chrome DevTools WebSocket failed")));
    });
  }
  async closePage(value: string, pageId: string): Promise<void> { await fetchJson(`${value}/json/close/${encodeURIComponent(pageId)}`); }
}

export class CdpBrowserBackend implements BrowserBackend {
  private readonly endpoint: string;
  private readonly pages = new Map<string, CdpPage>();
  constructor(value: string, private readonly transport: CdpTransport = new WebSocketCdpTransport()) { this.endpoint = endpoint(value); }
  async createPersistentContext(_profileId: string): Promise<string> { await this.transport.verify(this.endpoint); return this.endpoint; }
  async openPage(contextId: string): Promise<string> { if (contextId !== this.endpoint) throw new Error("Chrome context does not belong to this broker"); const page = await this.transport.openPage(this.endpoint); this.pages.set(page.id, page); return page.id; }
  async screenshot(pageId: string) { const result = await this.transport.command(this.page(pageId), "Page.captureScreenshot", { format: "png", fromSurface: true }); if (typeof result.data !== "string") throw new Error("Chrome screenshot did not contain image data"); return { mediaType: "image/png" as const, data: result.data }; }
  async input(pageId: string, input: ScreenInput): Promise<void> {
    const page = this.page(pageId);
    if (input.type === "click") {
      await this.transport.command(page, "Input.dispatchMouseEvent", { type: "mousePressed", x: input.x, y: input.y, button: "left", clickCount: 1 });
      await this.transport.command(page, "Input.dispatchMouseEvent", { type: "mouseReleased", x: input.x, y: input.y, button: "left", clickCount: 1 });
    } else if (input.type === "scroll") {
      await this.transport.command(page, "Input.dispatchMouseEvent", { type: "mouseWheel", x: input.x ?? 0, y: input.y ?? 0, deltaX: 0, deltaY: input.deltaY ?? 0 });
    } else {
      await this.transport.command(page, "Input.dispatchKeyEvent", { type: "keyDown", key: input.key, text: input.key && input.key.length === 1 ? input.key : undefined });
      await this.transport.command(page, "Input.dispatchKeyEvent", { type: "keyUp", key: input.key });
    }
  }
  async closePage(pageId: string): Promise<void> { this.page(pageId); this.pages.delete(pageId); await this.transport.closePage(this.endpoint, pageId); }
  private page(pageId: string): CdpPage { const page = this.pages.get(pageId); if (!page) throw new Error("Chrome page is not owned by this broker"); return page; }
}
