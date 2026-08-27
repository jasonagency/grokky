import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { IntegrationRecord, IntegrationVerification } from "../../shared/control-plane-contracts";
import { GitRepository } from "./git-repository";
import { WorktreeManager } from "./worktree-manager";

export interface IntegrationRequest {
  taskId: string;
  leaseId?: string;
  repository: GitRepository;
  taskBranch: string;
  targetRef: string;
}

export interface VerificationCommand { command: string; args: string[] }

function run(command: string, args: string[], cwd: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let detail = "";
    const append = (chunk: Buffer) => { detail = `${detail}${chunk.toString("utf8")}`.slice(-20_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => resolve({ ok: false, detail: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, detail: detail.trim() }));
  });
}

export class IntegrationQueue {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly worktrees: WorktreeManager;

  constructor(private readonly root: string, private readonly onRecord?: (record: IntegrationRecord) => Promise<void>) { this.worktrees = new WorktreeManager(root); }

  integrate(request: IntegrationRequest, commands: VerificationCommand[] = []): Promise<IntegrationRecord> {
    return this.enqueue(() => this.integrateUnlocked(request, commands));
  }

  private async integrateUnlocked(request: IntegrationRequest, commands: VerificationCommand[]): Promise<IntegrationRecord> {
    const now = Date.now();
    const record: IntegrationRecord = { id: `integration:${randomUUID()}`, taskId: request.taskId, ...(request.leaseId ? { leaseId: request.leaseId } : {}), repositoryId: request.repository.id, taskBranch: request.taskBranch, targetRef: request.targetRef, status: "queued", verification: [], createdAt: now, updatedAt: now };
    await this.persist(record);
    let worktree: Awaited<ReturnType<WorktreeManager["createIntegration"]>>;
    try {
      record.status = "integrating";
      record.updatedAt = Date.now();
      await this.persist(record);
      worktree = await this.worktrees.createIntegration(request.repository, request.taskId, request.targetRef);
      const merge = await request.repository.git(["merge", "--no-ff", "--no-edit", request.taskBranch], { cwd: worktree.path, allowFailure: true });
      if (merge.code !== 0) {
        record.status = "conflict";
        record.conflictFiles = await request.repository.conflictFiles(worktree.path);
        record.error = merge.stderr || merge.stdout || "Integration conflict";
        await request.repository.git(["merge", "--abort"], { cwd: worktree.path, allowFailure: true });
        record.updatedAt = Date.now();
        await this.persist(record);
        return record;
      }
      for (const command of commands) {
        const result = await run(command.command, command.args, worktree.path);
        const verification: IntegrationVerification = { command: [command.command, ...command.args].join(" "), ok: result.ok, ...(result.detail ? { detail: result.detail } : {}) };
        record.verification.push(verification);
        if (!result.ok) {
          record.status = "failed";
          record.error = `Verification failed: ${verification.command}`;
          record.updatedAt = Date.now();
          await this.persist(record);
          return record;
        }
      }
      record.resultCommit = await request.repository.head(worktree.path);
      record.status = "succeeded";
      record.updatedAt = Date.now();
      await this.persist(record);
      return record;
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : "Integration failed";
      record.updatedAt = Date.now();
      await this.persist(record);
      return record;
    } finally {
      if (worktree!) {
        try {
          if (!await request.repository.status(worktree.path)) await this.worktrees.removeClean(request.repository, worktree.path);
        } catch (error) {
          record.cleanupWarning = error instanceof Error ? error.message : "Integration worktree cleanup failed";
          record.updatedAt = Date.now();
          await this.persist(record);
        }
      }
    }
  }

  private async persist(record: IntegrationRecord): Promise<void> {
    await this.onRecord?.(structuredClone(record));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
