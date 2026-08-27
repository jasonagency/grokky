import { randomUUID, createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { IntegrationRecord, WorkspaceLease, WorkspaceLeaseRequest, WorkspaceStateSnapshot } from "../../shared/control-plane-contracts";
import { GitRepository } from "./git-repository";
import { WorktreeManager } from "./worktree-manager";

export interface WorkspaceLeaseStore {
  readWorkspaceState(): Promise<string | null>;
  writeWorkspaceState(snapshot: string): Promise<void>;
}

function clone<T>(value: T): T { return structuredClone(value); }

export class WorkspaceLeaseManager {
  private value: WorkspaceStateSnapshot = { revision: 0, leases: [], integrations: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly worktrees: WorktreeManager;

  constructor(private readonly store: WorkspaceLeaseStore, worktreeRoot: string, private readonly now: () => number = Date.now) {
    this.worktrees = new WorktreeManager(worktreeRoot);
  }

  initialize(): Promise<void> {
    return this.enqueue(async () => {
      const stored = await this.store.readWorkspaceState();
      this.value = stored ? JSON.parse(stored) as WorkspaceStateSnapshot : { revision: 0, leases: [], integrations: [] };
      await this.reconcileUnlocked();
    });
  }

  snapshot(): WorkspaceStateSnapshot { return clone(this.value); }

  acquire(request: WorkspaceLeaseRequest): Promise<WorkspaceLease> {
    return this.enqueue(async () => {
      if (!request.taskId || !request.holderId) throw new Error("Workspace leases require task and holder IDs");
      const workspace = await realpath(resolve(request.workspace));
      const repository = await GitRepository.tryOpen(workspace);
      const now = this.now();
      let lease: WorkspaceLease;
      if (repository && request.mode === "write") {
        const baseCommit = await repository.head();
        const worktree = await this.worktrees.create(repository, request.taskId, baseCommit);
        lease = { id: `workspace:${randomUUID()}`, taskId: request.taskId, repositoryId: repository.id, kind: "git", mode: "write", writable: true, workspace: repository.root, root: worktree.path, holderId: request.holderId, status: "active", branch: worktree.branch, baseCommit, createdAt: now, updatedAt: now };
      } else {
        const repositoryId = repository?.id ?? createHash("sha256").update(workspace).digest("hex").slice(0, 24);
        if (request.mode === "write" && this.value.leases.some((item) => item.kind === "directory" && item.repositoryId === repositoryId && item.writable && item.status === "active")) {
          throw new Error("Non-Git workspaces use one exclusive mutating lease");
        }
        lease = { id: `workspace:${randomUUID()}`, taskId: request.taskId, repositoryId, kind: repository ? "git" : "directory", mode: request.mode, writable: !repository && request.mode === "write", workspace: repository?.root ?? workspace, root: repository?.root ?? workspace, holderId: request.holderId, status: "active", ...(repository ? { baseCommit: await repository.head() } : {}), createdAt: now, updatedAt: now };
      }
      this.value.leases.push(lease);
      await this.commit();
      return clone(lease);
    });
  }

  transfer(leaseId: string, holderId: string): Promise<WorkspaceLease> {
    return this.enqueue(async () => {
      const lease = this.requireActive(leaseId);
      if (!holderId.trim()) throw new Error("Workspace lease holder is required");
      lease.holderId = holderId;
      lease.updatedAt = this.now();
      await this.commit();
      return clone(lease);
    });
  }

  complete(leaseId: string): Promise<WorkspaceLease> {
    return this.enqueue(async () => {
      const lease = this.requireActive(leaseId);
      lease.status = "completed";
      lease.updatedAt = this.now();
      if (lease.kind === "git" && lease.writable) {
        const repository = await GitRepository.open(lease.root);
        if (await repository.status(lease.root)) {
          lease.status = "recovery";
          lease.recoveryReason = "Completed worktree is dirty and was retained for recovery.";
        }
      }
      await this.commit();
      return clone(lease);
    });
  }

  recordIntegration(record: IntegrationRecord): Promise<void> {
    return this.enqueue(async () => {
      const index = this.value.integrations.findIndex((entry) => entry.id === record.id);
      if (index >= 0) this.value.integrations[index] = clone(record);
      else this.value.integrations.push(clone(record));
      await this.commit();
    });
  }

  markIntegrated(leaseId: string): Promise<void> {
    return this.enqueue(async () => {
      const lease = this.value.leases.find((entry) => entry.id === leaseId);
      if (!lease) throw new Error("Workspace lease was not found");
      lease.status = "integrated";
      lease.updatedAt = this.now();
      await this.commit();
    });
  }

  private requireActive(leaseId: string): WorkspaceLease {
    const lease = this.value.leases.find((entry) => entry.id === leaseId);
    if (!lease) throw new Error("Workspace lease was not found");
    if (lease.status !== "active") throw new Error("Workspace lease is not active");
    return lease;
  }

  private async reconcileUnlocked(): Promise<void> {
    let changed = false;
    for (const lease of this.value.leases) {
      if (lease.kind !== "git" || !lease.writable || lease.status === "integrated") continue;
      try {
        if (!(await stat(lease.root)).isDirectory()) throw new Error("missing");
      } catch {
        lease.status = "recovery";
        lease.recoveryReason = "Worktree directory is missing; repair or recover it explicitly.";
        lease.updatedAt = this.now();
        changed = true;
        continue;
      }
      if (lease.status === "completed") {
        const repository = await GitRepository.open(lease.root);
        if (await repository.status(lease.root)) {
          lease.status = "recovery";
          lease.recoveryReason = "Completed worktree is dirty and was retained for recovery.";
          lease.updatedAt = this.now();
          changed = true;
        }
      }
    }
    if (changed) await this.commit();
  }

  private async commit(): Promise<void> {
    this.value.revision += 1;
    await this.store.writeWorkspaceState(JSON.stringify(this.value));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
