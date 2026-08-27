import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RemoteHostState } from "../shared/remote-protocol";
import { REMOTE_PROTOCOL } from "../shared/remote-protocol";

const EMPTY: RemoteHostState = { protocolMajor: REMOTE_PROTOCOL.major, cursor: 0, jobs: [], events: [], commandIds: [] };

export class HostStore {
  private state: RemoteHostState = structuredClone(EMPTY);
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly pathname?: string) {}
  async initialize(): Promise<void> {
    if (!this.pathname) return;
    try { this.state = JSON.parse(await readFile(this.pathname, "utf8")) as RemoteHostState; } catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
  }
  snapshot(): RemoteHostState { return structuredClone(this.state); }
  async mutate<T>(operation: (state: RemoteHostState) => T | Promise<T>): Promise<T> {
    const pending = this.queue.then(async () => { const candidate = structuredClone(this.state); const result = await operation(candidate); await this.persist(candidate); this.state = candidate; return result; });
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
  private async persist(state: RemoteHostState): Promise<void> {
    if (!this.pathname) return;
    await mkdir(dirname(this.pathname), { recursive: true });
    const next = `${this.pathname}.next`;
    await writeFile(next, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(next, this.pathname);
  }
}
