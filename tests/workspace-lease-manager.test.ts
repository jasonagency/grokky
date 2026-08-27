import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WorkspaceLeaseManager, type WorkspaceLeaseStore } from "../src/main/workspaces/workspace-lease-manager";
import type { WorkspaceStateSnapshot } from "../src/shared/control-plane-contracts";
import { cleanupDirectories, createRepository } from "./helpers/git-fixtures";

class MemoryWorkspaceStore implements WorkspaceLeaseStore {
  value: WorkspaceStateSnapshot | null = null;
  async readWorkspaceState() { return this.value ? JSON.stringify(this.value) : null; }
  async writeWorkspaceState(value: string) { this.value = JSON.parse(value) as WorkspaceStateSnapshot; }
}

const directories: string[] = [];
afterEach(() => cleanupDirectories(directories));

describe("workspace lease manager", () => {
  test("isolates concurrent Git writers and transfers one lease without adding a writer", async () => {
    const repository = await createRepository(directories);
    const leaseRoot = await mkdtemp(join(tmpdir(), "grokky-leases-"));
    directories.push(leaseRoot);
    const manager = new WorkspaceLeaseManager(new MemoryWorkspaceStore(), leaseRoot);
    await manager.initialize();

    const first = await manager.acquire({ taskId: "task-a", workspace: repository, holderId: "worker-a", mode: "write" });
    const second = await manager.acquire({ taskId: "task-b", workspace: repository, holderId: "worker-b", mode: "write" });

    expect(first.root).not.toBe(second.root);
    expect(first.branch).not.toBe(second.branch);
    expect(first.repositoryId).toBe(second.repositoryId);

    const transferred = await manager.transfer(first.id, "verifier-a");
    expect(transferred.holderId).toBe("verifier-a");
    expect(manager.snapshot().leases.filter((lease) => lease.status === "active")).toHaveLength(2);
  });

  test("allows only one writer for a non-Git directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "grokky-directory-"));
    const leaseRoot = await mkdtemp(join(tmpdir(), "grokky-leases-"));
    directories.push(workspace, leaseRoot);
    const manager = new WorkspaceLeaseManager(new MemoryWorkspaceStore(), leaseRoot);
    await manager.initialize();

    const lease = await manager.acquire({ taskId: "task-a", workspace, holderId: "worker-a", mode: "write" });
    expect(lease.kind).toBe("directory");
    await expect(manager.acquire({ taskId: "task-b", workspace, holderId: "worker-b", mode: "write" })).rejects.toThrow("exclusive");

    const reader = await manager.acquire({ taskId: "task-read", workspace, holderId: "reader", mode: "read" });
    expect(reader.writable).toBe(false);
  });
});
