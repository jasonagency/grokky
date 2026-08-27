import type { UpdateChannel, UpdateReleaseInfo, UpdateSnapshot } from "../shared/contracts";

export type UpdateAdapterEvent =
  | { type: "checking" }
  | { type: "not-available" }
  | { type: "available"; info: UpdateReleaseInfo }
  | { type: "progress"; percent: number; transferred: number; total: number }
  | { type: "downloaded"; info: UpdateReleaseInfo; checksumVerified: boolean; signatureVerified: boolean }
  | { type: "error"; error: Error };

export interface UpdateAdapter {
  readonly enabled: boolean;
  configure(channel: UpdateChannel): void;
  subscribe(listener: (event: UpdateAdapterEvent) => void): () => void;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  quitAndInstall(): void;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  channel?: UpdateChannel;
  getRestartBlockers?: () => string[] | Promise<string[]>;
  checkOnStart?: boolean;
}

type ParsedVersion = { core: [number, number, number]; prerelease?: { channel: string; number: number } };

function parseVersion(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z][a-z0-9-]*)(?:\.(\d+))?)?$/i.exec(version.trim());
  if (!match) return null;
  const values = match.slice(1, 4).map((value) => Number(value));
  if (values.some((value) => !Number.isSafeInteger(value))) return null;
  return {
    core: values as [number, number, number],
    ...(match[4] ? { prerelease: { channel: match[4].toLowerCase(), number: Number(match[5] ?? 0) } } : {}),
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index]! - right.core[index]!;
  }
  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  const channel = left.prerelease.channel.localeCompare(right.prerelease.channel);
  return channel || left.prerelease.number - right.prerelease.number;
}

function validSha512(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try { return Buffer.from(value, "base64").byteLength === 64; } catch { return false; }
}

export function validateUpdateRelease(info: UpdateReleaseInfo, currentVersion: string, channel: UpdateChannel): string | null {
  const current = parseVersion(currentVersion);
  const candidate = parseVersion(info.version);
  if (!current || !candidate) return "Update metadata contains a malformed version";
  if (compareVersions(candidate, current) <= 0) return "Update is not newer than the installed version";
  if (info.channel !== channel) return `Update belongs to the ${info.channel} channel, not ${channel}`;
  if (channel === "stable" && candidate.prerelease) return "Stable updates cannot use a prerelease version";
  if (channel === "beta" && candidate.prerelease?.channel !== "beta") return "Beta updates must use a beta prerelease version";
  if (!Array.isArray(info.files) || info.files.length === 0) return "Update metadata does not contain an installer";
  for (const file of info.files) {
    let url: URL;
    try { url = new URL(file.url); } catch { return "Update metadata contains an invalid installer URL"; }
    if (url.protocol !== "https:") return "Update installers must use HTTPS";
    if (!validSha512(file.sha512)) return "Update metadata contains an invalid SHA-512 checksum";
    if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size <= 0)) return "Update metadata contains an invalid installer size";
  }
  if (info.releaseUrl) {
    try {
      if (new URL(info.releaseUrl).protocol !== "https:") return "Update release details must use HTTPS";
    } catch { return "Update metadata contains an invalid release URL"; }
  }
  return null;
}

const initialSnapshot = (channel: UpdateChannel): UpdateSnapshot => ({ status: "idle", channel, blockers: [] });

export class UpdateService {
  private value: UpdateSnapshot;
  private unsubscribe?: () => void;
  private readonly listeners = new Set<(snapshot: UpdateSnapshot) => void>();

  constructor(private readonly adapter: UpdateAdapter, private readonly options: UpdateServiceOptions) {
    this.value = initialSnapshot(options.channel ?? "stable");
  }

  async initialize(channel = this.value.channel): Promise<void> {
    this.value = initialSnapshot(channel);
    this.adapter.configure(this.value.channel);
    this.unsubscribe = this.adapter.subscribe((event) => this.onAdapterEvent(event));
    if (this.adapter.enabled && this.options.checkOnStart !== false) {
      void this.checkForUpdates().catch(() => undefined);
    }
  }

  shutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  snapshot(): UpdateSnapshot { return structuredClone(this.value); }

  subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async checkForUpdates(): Promise<void> {
    if (!this.adapter.enabled) {
      this.fail("Automatic updates are available only in packaged builds");
      return;
    }
    this.set({ ...initialSnapshot(this.value.channel), status: "checking" });
    try { await this.adapter.checkForUpdates(); } catch (error) { this.fail(this.message(error)); }
  }

  async downloadUpdate(): Promise<void> {
    if (this.value.status !== "available" || !this.value.info) throw new Error("No verified update is available to download");
    this.set({ ...this.value, status: "downloading", progress: { percent: 0, transferred: 0, total: 0 }, error: undefined });
    try { await this.adapter.downloadUpdate(); } catch (error) { this.fail(this.message(error)); }
  }

  async installUpdate(): Promise<string[]> {
    if (this.value.status !== "downloaded" && this.value.status !== "blocked") throw new Error("Download and verify the update before restarting");
    const blockers = [...new Set((await this.options.getRestartBlockers?.() ?? []).map((entry) => entry.trim()).filter(Boolean))];
    if (blockers.length) {
      this.set({ ...this.value, status: "blocked", blockers, error: undefined });
      return blockers;
    }
    this.set({ ...this.value, status: "downloaded", blockers: [], error: undefined });
    this.adapter.quitAndInstall();
    return [];
  }

  async setChannel(channel: UpdateChannel): Promise<void> {
    if (channel === this.value.channel) return;
    this.adapter.configure(channel);
    this.set(initialSnapshot(channel));
    if (this.adapter.enabled) await this.checkForUpdates();
  }

  private onAdapterEvent(event: UpdateAdapterEvent): void {
    if (event.type === "checking") this.set({ ...initialSnapshot(this.value.channel), status: "checking" });
    else if (event.type === "not-available") this.set(initialSnapshot(this.value.channel));
    else if (event.type === "available") {
      const error = validateUpdateRelease(event.info, this.options.currentVersion, this.value.channel);
      if (error) this.fail(error);
      else this.set({ status: "available", channel: this.value.channel, info: event.info, blockers: [] });
    } else if (event.type === "progress") {
      if (this.value.info) this.set({ ...this.value, status: "downloading", progress: { percent: Math.max(0, Math.min(100, event.percent)), transferred: Math.max(0, event.transferred), total: Math.max(0, event.total) } });
    } else if (event.type === "downloaded") {
      const metadataError = validateUpdateRelease(event.info, this.options.currentVersion, this.value.channel);
      if (metadataError) this.fail(metadataError);
      else if (!event.checksumVerified) this.fail("Downloaded update failed its SHA-512 integrity check");
      else if (!event.signatureVerified) this.fail("Downloaded update is not signed by the application owner");
      else this.set({ status: "downloaded", channel: this.value.channel, info: event.info, progress: { percent: 100, transferred: event.info.files[0]?.size ?? 0, total: event.info.files[0]?.size ?? 0 }, blockers: [] });
    } else this.fail(this.message(event.error));
  }

  private fail(error: string): void { this.set({ ...initialSnapshot(this.value.channel), status: "error", error }); }
  private message(error: unknown): string { return error instanceof Error && error.message ? error.message : "The update operation failed"; }
  private set(snapshot: UpdateSnapshot): void {
    this.value = structuredClone(snapshot);
    for (const listener of this.listeners) listener(this.snapshot());
  }
}

export class DisabledUpdateAdapter implements UpdateAdapter {
  readonly enabled = false;
  configure(): void {}
  subscribe(): () => void { return () => undefined; }
  async checkForUpdates(): Promise<void> {}
  async downloadUpdate(): Promise<void> { throw new Error("Automatic updates are unavailable in this build"); }
  quitAndInstall(): void { throw new Error("Automatic updates are unavailable in this build"); }
}

export async function createElectronUpdateAdapter(repository: string): Promise<UpdateAdapter> {
  const { autoUpdater } = await import("electron-updater");
  const listeners = new Set<(event: UpdateAdapterEvent) => void>();
  const release = (info: import("electron-updater").UpdateInfo): UpdateReleaseInfo => {
    const prerelease = parseVersion(info.version)?.prerelease?.channel;
    const notes = Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map((entry) => entry.note).filter(Boolean).join("\n\n")
      : info.releaseNotes ?? undefined;
    return {
      version: info.version,
      channel: prerelease === "beta" ? "beta" : "stable",
      ...(info.releaseName ? { releaseName: info.releaseName } : {}),
      ...(notes ? { releaseNotes: notes } : {}),
      releaseUrl: `https://github.com/${repository}/releases/tag/v${info.version}`,
      ...(info.releaseDate ? { publishedAt: info.releaseDate } : {}),
      files: info.files.map((file) => {
        const base = `https://github.com/${repository}/releases/download/v${info.version}/`;
        return { url: new URL(file.url, base).toString(), sha512: file.sha512, ...(file.size ? { size: file.size } : {}) };
      }),
    };
  };
  const emit = (event: UpdateAdapterEvent) => { for (const listener of listeners) listener(event); };
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.on("checking-for-update", () => emit({ type: "checking" }));
  autoUpdater.on("update-not-available", () => emit({ type: "not-available" }));
  autoUpdater.on("update-available", (info) => emit({ type: "available", info: release(info) }));
  autoUpdater.on("download-progress", (progress) => emit({ type: "progress", percent: progress.percent, transferred: progress.transferred, total: progress.total }));
  autoUpdater.on("update-downloaded", (info) => emit({ type: "downloaded", info: release(info), checksumVerified: true, signatureVerified: true }));
  autoUpdater.on("error", (error) => emit({ type: "error", error }));
  return {
    enabled: true,
    configure(channel) {
      autoUpdater.channel = channel;
      autoUpdater.allowPrerelease = channel === "beta";
      autoUpdater.allowDowngrade = false;
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async checkForUpdates() { await autoUpdater.checkForUpdates(); },
    async downloadUpdate() { await autoUpdater.downloadUpdate(); },
    quitAndInstall() { autoUpdater.quitAndInstall(false, true); },
  };
}
