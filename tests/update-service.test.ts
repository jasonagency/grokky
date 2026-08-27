import { describe, expect, test, vi } from "vitest";
import type { UpdateChannel, UpdateReleaseInfo } from "../src/shared/contracts";
import { HostUpdateService } from "../src/main/remote/host-update-service";
import { assessRemoteCompatibility } from "../src/shared/remote-protocol";
import { UpdateService, type UpdateAdapter, type UpdateAdapterEvent } from "../src/main/update-service";

const checksum = Buffer.alloc(64, 7).toString("base64");
const release = (version = "1.1.0", channel: UpdateChannel = "stable"): UpdateReleaseInfo => ({
  version,
  channel,
  releaseUrl: `https://github.com/jasonagency/grokky/releases/tag/v${version}`,
  files: [{ url: `https://github.com/jasonagency/grokky/releases/download/v${version}/Grokky.dmg`, sha512: checksum, size: 42_000 }],
});

class FakeUpdateAdapter implements UpdateAdapter {
  readonly enabled = true;
  channel: UpdateChannel = "stable";
  listener?: (event: UpdateAdapterEvent) => void;
  checks = 0;
  downloads = 0;
  installs = 0;
  configure(channel: UpdateChannel) { this.channel = channel; }
  subscribe(listener: (event: UpdateAdapterEvent) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  async checkForUpdates() { this.checks += 1; this.listener?.({ type: "checking" }); }
  async downloadUpdate() { this.downloads += 1; }
  quitAndInstall() { this.installs += 1; }
  emit(event: UpdateAdapterEvent) { this.listener?.(event); }
}

describe("UpdateService", () => {
  test("starts the packaged check without delaying application startup", async () => {
    const adapter = new FakeUpdateAdapter();
    adapter.checkForUpdates = vi.fn(() => new Promise<void>(() => undefined));
    const service = new UpdateService(adapter, { currentVersion: "1.0.0" });
    await expect(service.initialize()).resolves.toBeUndefined();
    expect(adapter.checkForUpdates).toHaveBeenCalledOnce();
    expect(service.snapshot().status).toBe("checking");
  });

  test("downloads during active work but refuses restart until every blocker clears", async () => {
    const adapter = new FakeUpdateAdapter();
    let blockers = ["1 local conversation is still running", "1 workspace integration is unresolved"];
    const service = new UpdateService(adapter, { currentVersion: "1.0.0", checkOnStart: false, getRestartBlockers: () => blockers });
    await service.initialize();
    adapter.emit({ type: "available", info: release() });

    await service.downloadUpdate();
    expect(adapter.downloads).toBe(1);
    adapter.emit({ type: "downloaded", info: release(), checksumVerified: true, signatureVerified: true });
    expect(service.snapshot().status).toBe("downloaded");

    await expect(service.installUpdate()).resolves.toEqual(blockers);
    expect(service.snapshot()).toMatchObject({ status: "blocked", blockers });
    expect(adapter.installs).toBe(0);

    blockers = [];
    await expect(service.installUpdate()).resolves.toEqual([]);
    expect(adapter.installs).toBe(1);
  });

  test.each([
    ["downgrade", release("0.9.0"), "Update is not newer"],
    ["wrong channel", release("1.1.0-beta.1", "beta"), "belongs to the beta channel"],
    ["malformed version", release("next"), "malformed version"],
    ["insecure artifact", { ...release(), files: [{ ...release().files[0]!, url: "http://example.test/Grokky.dmg" }] }, "must use HTTPS"],
    ["invalid checksum", { ...release(), files: [{ ...release().files[0]!, sha512: "not-a-digest" }] }, "invalid SHA-512"],
  ])("rejects %s metadata before download", async (_name, info, message) => {
    const adapter = new FakeUpdateAdapter();
    const service = new UpdateService(adapter, { currentVersion: "1.0.0", checkOnStart: false });
    await service.initialize();
    adapter.emit({ type: "available", info: info as UpdateReleaseInfo });
    expect(service.snapshot()).toMatchObject({ status: "error" });
    expect(service.snapshot().error).toContain(message);
    await expect(service.downloadUpdate()).rejects.toThrow("No verified update");
  });

  test.each([
    ["unsigned", true, false, "not signed"],
    ["checksum-mismatched", false, true, "SHA-512"],
  ])("rejects a %s downloaded package", async (_name, checksumVerified, signatureVerified, message) => {
    const adapter = new FakeUpdateAdapter();
    const service = new UpdateService(adapter, { currentVersion: "1.0.0", checkOnStart: false });
    await service.initialize();
    adapter.emit({ type: "available", info: release() });
    await service.downloadUpdate();
    adapter.emit({ type: "downloaded", info: release(), checksumVerified, signatureVerified });
    expect(service.snapshot().error).toContain(message);
    await expect(service.installUpdate()).rejects.toThrow("Download and verify");
  });

  test("keeps stable and beta channels explicit and never enables downgrade", async () => {
    const adapter = new FakeUpdateAdapter();
    const service = new UpdateService(adapter, { currentVersion: "1.0.0-beta.1", channel: "beta", checkOnStart: false });
    await service.initialize();
    adapter.emit({ type: "available", info: release("1.0.0-beta.2", "beta") });
    expect(service.snapshot().status).toBe("available");
    await service.setChannel("stable");
    expect(adapter.channel).toBe("stable");
    expect(adapter.checks).toBe(1);
  });
});

describe("remote host updates", () => {
  test("accepts compatible skew and preserves export and recovery during incompatible skew", () => {
    expect(assessRemoteCompatibility({ major: 1, minor: 4 })).toMatchObject({ newJobsAllowed: true, exportAllowed: true, recoveryAllowed: true });
    expect(assessRemoteCompatibility({ major: 2, minor: 0 })).toMatchObject({ newJobsAllowed: false, exportAllowed: true, recoveryAllowed: true });
  });

  test("backs up, health checks, and rolls an incompatible host back", async () => {
    const adapter = {
      backup: vi.fn(async () => "backup-1"),
      install: vi.fn(async () => undefined),
      healthCheck: vi.fn(async () => ({ healthy: true, protocol: { major: 2, minor: 0 } })),
      rollback: vi.fn(async () => undefined),
    };
    const result = await new HostUpdateService(adapter).apply("host-update.pkg");
    expect(result).toMatchObject({ status: "incompatible", backupId: "backup-1" });
    expect(adapter.rollback).toHaveBeenCalledWith("backup-1");
  });

  test("does not claim a host backup was restored when rollback fails", async () => {
    const adapter = {
      backup: vi.fn(async () => "backup-2"),
      install: vi.fn(async () => { throw new Error("install failed"); }),
      healthCheck: vi.fn(async () => ({ healthy: true, protocol: { major: 1, minor: 0 } })),
      rollback: vi.fn(async () => { throw new Error("restore failed"); }),
    };
    await expect(new HostUpdateService(adapter).apply("host-update.pkg")).rejects.toThrow("Rollback backup-2 also failed");
    expect(adapter.rollback).toHaveBeenCalledOnce();
  });
});
