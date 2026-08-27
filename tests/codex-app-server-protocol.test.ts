import { describe, expect, test } from "vitest";
import { CodexAppServerClient } from "../src/main/harnesses/codex-app-server-client";
import type { CodexAppServerTransport } from "../src/main/harnesses/codex-app-server-process";
import { resolveCodexExecutable } from "../src/main/harnesses/codex-app-server-process";

class FakeTransport implements CodexAppServerTransport {
  writes: string[] = [];
  line?: (line: string) => void;
  exit?: (error: Error) => void;
  write(message: string) { this.writes.push(message); }
  onLine(listener: (line: string) => void) { this.line = listener; return () => undefined; }
  onExit(listener: (error: Error) => void) { this.exit = listener; return () => undefined; }
  async close() {}
  respond(index: number, result: unknown) {
    const request = JSON.parse(this.writes[index]!) as { id: number };
    this.line?.(JSON.stringify({ id: request.id, result }));
  }
}

describe("Codex App Server protocol client", () => {
  test("performs initialize handshake and routes responses", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport);
    const initialized = client.initialize();
    expect(JSON.parse(transport.writes[0]!)).toMatchObject({ method: "initialize", params: { capabilities: { experimentalApi: true } } });
    transport.respond(0, { userAgent: "codex-cli/0.149.1", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" });
    await initialized;
    expect(JSON.parse(transport.writes[1]!)).toEqual({ method: "initialized" });
    await client.close();
  });

  test("fails pending requests on malformed JSON and process exit", async () => {
    const malformedTransport = new FakeTransport();
    const malformed = new CodexAppServerClient(malformedTransport);
    const pending = malformed.request("thread/start", {});
    malformedTransport.line?.("not-json");
    await expect(pending).rejects.toThrow("protocol error");

    const exitTransport = new FakeTransport();
    const exited = new CodexAppServerClient(exitTransport);
    const exitPending = exited.request("thread/start", {});
    exitTransport.exit?.(new Error("process exited with code 2"));
    await expect(exitPending).rejects.toThrow("process exited with code 2");
  });

  test("rejects unsupported initialize responses", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport);
    const initialized = client.initialize();
    transport.respond(0, { protocolVersion: 999 });
    await expect(initialized).rejects.toThrow("unsupported initialize response");
  });

  test("resolves packaged macOS and Windows executables", () => {
    expect(resolveCodexExecutable({ resourcesPath: "/Applications/PuckBot.app/Contents/Resources", platform: "darwin", arch: "arm64", exists: () => true }))
      .toContain("codex-darwin-arm64");
    expect(resolveCodexExecutable({ resourcesPath: "C:\\Program Files\\PuckBot\\resources", platform: "win32", arch: "x64", exists: () => true }))
      .toContain("codex-win32-x64");
  });
});
