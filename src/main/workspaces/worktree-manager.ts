import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isPathWithin } from "../path-boundary";
import { GitRepository } from "./git-repository";

export interface ManagedWorktree {
  path: string;
  branch: string;
  baseCommit: string;
}

function safeSegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return normalized || "task";
}

export class WorktreeManager {
  constructor(private readonly root: string) {}

  async create(repository: GitRepository, taskId: string, baseCommit: string): Promise<ManagedWorktree> {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    return this.createNamed(repository, `grokky/${safeSegment(taskId)}-${suffix}`, baseCommit, `${safeSegment(taskId)}-${suffix}`);
  }

  async createIntegration(repository: GitRepository, integrationId: string, targetRef: string): Promise<ManagedWorktree> {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    return this.createNamed(repository, `grokky/integration-${safeSegment(integrationId)}-${suffix}`, targetRef, `integration-${safeSegment(integrationId)}-${suffix}`);
  }

  async removeClean(repository: GitRepository, pathname: string): Promise<void> {
    if (await repository.status(pathname)) throw new Error("Dirty worktrees are retained for explicit recovery");
    await repository.git(["worktree", "unlock", pathname], { allowFailure: true });
    await repository.git(["worktree", "remove", pathname]);
  }

  async repair(repository: GitRepository, pathname: string): Promise<void> {
    await repository.git(["worktree", "repair", pathname]);
  }

  private async createNamed(repository: GitRepository, branch: string, baseCommit: string, directoryName: string): Promise<ManagedWorktree> {
    const repositoryRoot = resolve(this.root, repository.id);
    const pathname = resolve(repositoryRoot, directoryName);
    if (!isPathWithin(repositoryRoot, pathname)) throw new Error("Invalid worktree path");
    await mkdir(repositoryRoot, { recursive: true });
    await repository.git(["worktree", "add", "-b", branch, "--", pathname, baseCommit]);
    await repository.git(["worktree", "lock", "--reason", "Grokky workspace lease", pathname]);
    return { path: pathname, branch, baseCommit };
  }
}
