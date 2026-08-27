import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(output.trim() || `git exited ${code}`)));
  });
}

export async function createRepository(directories: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "grokky-repo-"));
  directories.push(directory);
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.email", "tests@grokky.local"]);
  await git(directory, ["config", "user.name", "Grokky Tests"]);
  await writeFile(join(directory, "README.md"), "base\n");
  await commitAll(directory, "initial");
  return directory;
}

export async function commitAll(directory: string, message: string): Promise<void> {
  await git(directory, ["add", "-A"]);
  await git(directory, ["commit", "-m", message]);
}

export async function cleanupDirectories(directories: string[]): Promise<void> {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}
