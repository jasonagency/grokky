import { execFile } from "node:child_process";
import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { ScreenInput } from "../shared/remote-protocol";
import type { DesktopSessionBackend } from "./desktop-screen-provider";

const run = promisify(execFile);
export interface LinuxDesktopDriver {
  capture(display: string): Promise<{ mediaType: "image/png" | "image/jpeg"; data: string }>;
  input(display: string, input: ScreenInput): Promise<void>;
}

class CommandDesktopDriver implements LinuxDesktopDriver {
  async capture(display: string) {
    const directory = await mkdtemp(join(tmpdir(), "grokky-linux-screen-")); const pathname = join(directory, "screen.png");
    try { await run("gnome-screenshot", ["--file", pathname], { env: { ...process.env, DISPLAY: display }, timeout: 15_000 }); return { mediaType: "image/png" as const, data: (await readFile(pathname)).toString("base64") }; }
    finally { await unlink(pathname).catch(() => undefined); await rmdir(directory).catch(() => undefined); }
  }
  async input(display: string, input: ScreenInput): Promise<void> {
    const options = { env: { ...process.env, DISPLAY: display }, timeout: 10_000 };
    if (input.type === "click") await run("xdotool", ["mousemove", String(input.x), String(input.y), "click", "1"], options);
    else if (input.type === "key") await run("xdotool", ["key", "--clearmodifiers", input.key!], options);
    else {
      const button = (input.deltaY ?? 0) < 0 ? "4" : "5"; const repeats = Math.min(20, Math.max(1, Math.ceil(Math.abs(input.deltaY ?? 1) / 100)));
      for (let index = 0; index < repeats; index += 1) await run("xdotool", ["click", button], options);
    }
  }
}

export class ProvisionedDesktopBackend implements DesktopSessionBackend {
  private readonly displays: string[];
  private readonly sessions = new Map<string, string>();
  constructor(displays: string[], private readonly driver: LinuxDesktopDriver = new CommandDesktopDriver(), getuid: () => number | undefined = () => process.getuid?.()) {
    const uid = getuid();
    if (uid === undefined || uid === 0) throw new Error("Linux desktop screen sessions must run as a non-root user");
    this.displays = [...new Set(displays.map((value) => value.trim()).filter(Boolean))];
    if (!this.displays.length || this.displays.some((value) => !/^:\d+(?:\.\d+)?$/.test(value))) throw new Error("Desktop displays must be an explicit comma-separated list such as :21,:22");
  }
  async createSession(_agentId: string): Promise<string> { const display = this.displays.find((candidate) => ![...this.sessions.values()].includes(candidate)); if (!display) throw new Error("No provisioned Linux desktop display is available"); const id = `desktop:${randomUUID()}`; this.sessions.set(id, display); return id; }
  screenshot(sessionId: string) { return this.driver.capture(this.display(sessionId)); }
  input(sessionId: string, input: ScreenInput) { return this.driver.input(this.display(sessionId), input); }
  async closeSession(sessionId: string): Promise<void> { this.display(sessionId); this.sessions.delete(sessionId); }
  private display(sessionId: string): string { const display = this.sessions.get(sessionId); if (!display) throw new Error("Provisioned desktop session was not found"); return display; }
}
