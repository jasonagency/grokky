import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WorkspaceLeaseManager, type WorkspaceLeaseStore } from "../src/main/workspaces/workspace-lease-manager";
import type { WorkspaceStateSnapshot } from "../src/shared/control-plane-contracts";
import { cleanupDirectories, createRepository } from "./helpers/git-fixtures";

class MemoryWorkspaceStore implements WorkspaceLeaseStore {
  value: string | null = null;
  async readWorkspaceState() { return this.value; }
  async writeWorkspaceState(value: string) { this.value = value; }
}

const directories: string[] = [];
afterEach(() => cleanupDirectories(directories));

describe("worktree recovery", () => {
  test("retains a dirty completed worktree for operator recovery", async () => {
    const checkout = await createRepository(directories);
    const root = await mkdtemp(join(tmpdir(), "grokky-recovery-"));
    directories.push(root);
    const store = new MemoryWorkspaceStore();
    const first = new WorkspaceLeaseManager(store, root);
    await first.initialize();
    const lease = await first.acquire({ taskId: "task-dirty", workspace: checkout, holderId: "worker", mode: "write" });
    await writeFile(join(lease.root, "dirty.txt"), "preserve me\n");
    await first.complete(lease.id);

    const restarted = new WorkspaceLeaseManager(store, root);
    await restarted.initialize();
    const recovered = restarted.snapshot().leases.find((entry) => entry.id === lease.id)!;
    expect(recovered.status).toBe("recovery");
    expect(recovered.recoveryReason).toContain("dirty");
  });

  test("marks a missing linked directory for repair", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokky-recovery-"));
    directories.push(root);
    const store = new MemoryWorkspaceStore();
    const snapshot: WorkspaceStateSnapshot = {
      revision: 1,
      leases: [{ id: "lease-missing", taskId: "task", repositoryId: "repo", kind: "git", mode: "write", writable: true, root: join(root, "missing"), workspace: join(root, "repo"), holderId: "worker", status: "active", branch: "grokky/task", baseCommit: "a".repeat(40), createdAt: 1, updatedAt: 1 }],
      integrations: [],
    };
    store.value = JSON.stringify(snapshot);

    const manager = new WorkspaceLeaseManager(store, root);
    await manager.initialize();

    expect(manager.snapshot().leases[0]).toMatchObject({ status: "recovery", recoveryReason: "Worktree directory is missing; repair or recover it explicitly." });
  });

  test("retains uncommitted work when an integrated branch is finalized", async () => {
    const checkout = await createRepository(directories);
    const root = await mkdtemp(join(tmpdir(), "grokky-recovery-"));
    directories.push(root);
    const manager = new WorkspaceLeaseManager(new MemoryWorkspaceStore(), root);
    await manager.initialize();
    const lease = await manager.acquire({ taskId: "task-integrated-dirty", workspace: checkout, holderId: "worker", mode: "write" });
    await writeFile(join(lease.root, "uncommitted.txt"), "preserve me\n");

    await manager.markIntegrated(lease.id);

    expect(manager.snapshot().leases.find((entry) => entry.id === lease.id)).toMatchObject({
      status: "recovery",
      recoveryReason: "Integrated branch still has uncommitted work and was retained for recovery.",
    });
  });
});
