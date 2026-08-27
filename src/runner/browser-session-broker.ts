import { randomUUID } from "node:crypto";
import type { ScreenInput } from "../shared/remote-protocol";

export interface BrowserBackend {
  createPersistentContext(profileId: string): Promise<string>;
  openPage(contextId: string): Promise<string>;
  screenshot(pageId: string): Promise<{ mediaType: "image/png" | "image/jpeg"; data: string }>;
  input(pageId: string, input: ScreenInput): Promise<void>;
  closePage(pageId: string): Promise<void>;
}

export class BrowserSessionBroker {
  private context?: Promise<string>;
  private pages = new Map<string, { pageId: string; agentId: string }>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly backend: BrowserBackend, private readonly profileId = "grokky-shared-approved-logins") {}
  create(agentId: string): Promise<string> { return this.serial(async () => { const context = await (this.context ??= this.backend.createPersistentContext(this.profileId)); const pageId = await this.backend.openPage(context); const sessionId = `browser:${randomUUID()}`; this.pages.set(sessionId, { pageId, agentId }); return sessionId; }); }
  async capture(sessionId: string) { return this.backend.screenshot(this.page(sessionId).pageId); }
  async input(sessionId: string, input: ScreenInput): Promise<void> { await this.backend.input(this.page(sessionId).pageId, input); }
  async close(sessionId: string): Promise<void> { const page = this.page(sessionId); this.pages.delete(sessionId); await this.backend.closePage(page.pageId); }
  pageForAgent(sessionId: string): string { return this.page(sessionId).agentId; }
  private page(sessionId: string) { const page = this.pages.get(sessionId); if (!page) throw new Error("Browser screen session was not found"); return page; }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const result = this.queue.then(operation, operation); this.queue = result.then(() => undefined, () => undefined); return result; }
}
