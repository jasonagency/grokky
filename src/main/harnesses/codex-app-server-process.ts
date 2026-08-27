import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { packagedCodexCandidate } from "../providers/codex-provider";

export interface CodexAppServerTransport {
  write(message: string): void;
  onLine(listener: (line: string) => void): () => void;
  onExit(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export interface CodexExecutableOptions {
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (path: string) => boolean;
}

export function resolveCodexExecutable(options: CodexExecutableOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const exists = options.exists ?? existsSync;
  if (options.resourcesPath) {
    const packaged = packagedCodexCandidate(options.resourcesPath, platform, arch);
    if (packaged && exists(packaged)) return packaged;
  }

  const packageArch = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  const packageName = platform === "darwin" && packageArch
    ? `@openai/codex-darwin-${packageArch}`
    : platform === "win32" && packageArch
      ? `@openai/codex-win32-${packageArch}`
      : platform === "linux" && packageArch
        ? `@openai/codex-linux-${packageArch}`
        : undefined;
  if (!packageName) throw new Error(`Codex App Server is unavailable for ${platform}/${arch}`);
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve(`${packageName}/package.json`);
    const triple = platform === "darwin"
      ? `${packageArch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
      : platform === "win32"
        ? `${packageArch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`
        : `${packageArch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`;
    const binary = join(dirname(packageJson), "vendor", triple, "bin", platform === "win32" ? "codex.exe" : "codex");
    if (!exists(binary)) throw new Error("binary missing");
    return binary;
  } catch (error) {
    throw new Error(`Unable to locate the bundled Codex App Server executable for ${platform}/${arch}`, { cause: error });
  }
}

export class CodexAppServerProcess implements CodexAppServerTransport {
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  private readonly stderr: string[] = [];
  private readonly lines;
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.lineListeners.forEach((listener) => listener(line)));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr.push(chunk);
      if (this.stderr.join("").length > 16_000) this.stderr.shift();
    });
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code, signal) => {
      if (this.closed) return;
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      const diagnostic = this.stderr.join("").trim().slice(-4_000);
      this.fail(new Error(`Codex App Server exited with ${detail}${diagnostic ? `: ${diagnostic}` : ""}`));
    });
  }

  static launch(options: { executable?: string; resourcesPath?: string } = {}): CodexAppServerProcess {
    const executable = options.executable ?? resolveCodexExecutable({ resourcesPath: options.resourcesPath });
    return new CodexAppServerProcess(spawn(executable, ["app-server", "--stdio"], {
      env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "grokky_app_server" },
      stdio: ["pipe", "pipe", "pipe"],
    }));
  }

  write(message: string): void {
    if (this.closed || !this.child.stdin.writable) throw new Error("Codex App Server transport is closed");
    this.child.stdin.write(`${message}\n`);
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private fail(error: Error): void {
    this.exitListeners.forEach((listener) => listener(error));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.lineListeners.clear();
    this.exitListeners.clear();
    if (!this.child.killed) this.child.kill();
  }
}
