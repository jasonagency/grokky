import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GitRepository } from "../src/main/workspaces/git-repository";
import { WorktreeManager } from "../src/main/workspaces/worktree-manager";
import { cleanupDirectories, createRepository } from "./helpers/git-fixtures";

const directories: string[] = [];
afterEach(() => cleanupDirectories(directories));

describe("worktree manager", () => {
  test("creates a locked branch outside the checkout and removes only clean worktrees", async () => {
    const checkout = await createRepository(directories);
    const root = await mkdtemp(join(tmpdir(), "grokky-worktrees-"));
    directories.push(root);
    const repository = await GitRepository.open(checkout);
    const manager = new WorktreeManager(root);

    const worktree = await manager.create(repository, "task-a", await repository.head());
    expect(worktree.path.startsWith(root)).toBe(true);
    expect(worktree.branch).toMatch(/^grokky\/task-a-/);
    expect((await repository.worktrees()).find((entry) => entry.branch === worktree.branch)?.locked).toBe(true);

    await manager.removeClean(repository, worktree.path);
    await expect(access(worktree.path)).rejects.toThrow();
  });
});
