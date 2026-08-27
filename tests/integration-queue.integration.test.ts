import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { IntegrationQueue } from "../src/main/workspaces/integration-queue";
import { GitRepository } from "../src/main/workspaces/git-repository";
import { WorktreeManager } from "../src/main/workspaces/worktree-manager";
import { cleanupDirectories, commitAll, createRepository } from "./helpers/git-fixtures";

const directories: string[] = [];
afterEach(() => cleanupDirectories(directories));

describe("integration queue", () => {
  test("integrates a clean branch and records verification and commit", async () => {
    const checkout = await createRepository(directories);
    const root = await mkdtemp(join(tmpdir(), "grokky-integration-"));
    directories.push(root);
    const repository = await GitRepository.open(checkout);
    const worktree = await new WorktreeManager(root).create(repository, "task-clean", await repository.head());
    await writeFile(join(worktree.path, "feature.txt"), "isolated\n");
    await commitAll(worktree.path, "add isolated feature");

    const persisted: string[] = [];
    const queue = new IntegrationQueue(root, async (record) => { persisted.push(record.status); });
    const result = await queue.integrate({ taskId: "task-clean", repository, taskBranch: worktree.branch, targetRef: await repository.head() }, [{ command: "git", args: ["status", "--short"] }]);

    expect(result.status).toBe("succeeded");
    expect(result.resultCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(result.verification).toEqual([{ command: "git status --short", ok: true }]);
    expect(persisted).toEqual(["queued", "integrating", "succeeded"]);
  });

  test("reports a conflict without changing either task branch", async () => {
    const checkout = await createRepository(directories);
    const root = await mkdtemp(join(tmpdir(), "grokky-integration-"));
    directories.push(root);
    const repository = await GitRepository.open(checkout);
    const base = await repository.head();
    const manager = new WorktreeManager(root);
    const first = await manager.create(repository, "task-first", base);
    const second = await manager.create(repository, "task-second", base);
    await writeFile(join(first.path, "README.md"), "first\n");
    await writeFile(join(second.path, "README.md"), "second\n");
    await commitAll(first.path, "first edit");
    await commitAll(second.path, "second edit");
    const queue = new IntegrationQueue(root);
    const accepted = await queue.integrate({ taskId: "task-first", repository, taskBranch: first.branch, targetRef: base });

    const conflicted = await queue.integrate({ taskId: "task-second", repository, taskBranch: second.branch, targetRef: accepted.resultCommit! });

    expect(conflicted.status).toBe("conflict");
    expect(await readFile(join(first.path, "README.md"), "utf8")).toBe("first\n");
    expect(await readFile(join(second.path, "README.md"), "utf8")).toBe("second\n");
  });
});
