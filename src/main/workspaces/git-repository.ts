import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export interface GitWorktreeEntry {
  path: string;
  head: string;
  branch?: string;
  locked: boolean;
  prunable: boolean;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(command: string, args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (target === "stdout") stdout = `${stdout}${chunk.toString("utf8")}`.slice(-100_000);
      else stderr = `${stderr}${chunk.toString("utf8")}`.slice(-100_000);
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 }));
  });
}

function requireSuccess(result: GitResult, action: string): string {
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `Git could not ${action}`);
  return result.stdout;
}

export class GitRepository {
  private constructor(
    readonly checkout: string,
    readonly root: string,
    readonly commonDirectory: string,
    readonly id: string,
  ) {}

  static async open(pathname: string): Promise<GitRepository> {
    const checkout = await realpath(resolve(pathname));
    const topLevelResult = await run("git", ["-C", checkout, "rev-parse", "--show-toplevel"], checkout);
    const root = await realpath(requireSuccess(topLevelResult, "find the repository root"));
    const commonResult = await run("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], root);
    const commonDirectory = await realpath(requireSuccess(commonResult, "find the common Git directory"));
    const id = createHash("sha256").update(commonDirectory).digest("hex").slice(0, 24);
    return new GitRepository(checkout, root, commonDirectory, id);
  }

  static async tryOpen(pathname: string): Promise<GitRepository | null> {
    try {
      return await GitRepository.open(pathname);
    } catch {
      return null;
    }
  }

  async git(args: string[], options: { allowFailure?: boolean; cwd?: string } = {}): Promise<GitResult> {
    const result = await run("git", args, options.cwd ?? this.root);
    if (!options.allowFailure) requireSuccess(result, args.join(" "));
    return result;
  }

  async head(cwd = this.root): Promise<string> {
    return requireSuccess(await run("git", ["rev-parse", "HEAD"], cwd), "resolve HEAD");
  }

  async status(cwd = this.root): Promise<string> {
    return (await this.git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd })).stdout;
  }

  async conflictFiles(cwd: string): Promise<string[]> {
    const result = await this.git(["diff", "--name-only", "--diff-filter=U"], { cwd, allowFailure: true });
    return result.stdout.split(/\r?\n/).filter(Boolean);
  }

  async worktrees(): Promise<GitWorktreeEntry[]> {
    const output = (await this.git(["worktree", "list", "--porcelain"])).stdout;
    if (!output) return [];
    return output.split(/\n\n+/).map((block) => {
      const lines = block.split(/\r?\n/);
      const worktree = lines.find((line) => line.startsWith("worktree "))?.slice(9);
      const head = lines.find((line) => line.startsWith("HEAD "))?.slice(5);
      if (!worktree || !head) throw new Error("Git returned malformed worktree metadata");
      const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
      return { path: resolve(worktree), head, ...(branch ? { branch } : {}), locked: lines.some((line) => line === "locked" || line.startsWith("locked ")), prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")) };
    });
  }
}
