import type { ScreenInput } from "../shared/remote-protocol";
import type { ScreenProvider } from "./screen-session-manager";

export interface DesktopSessionBackend {
  createSession(agentId: string): Promise<string>;
  screenshot(sessionId: string): Promise<{ mediaType: "image/png" | "image/jpeg"; data: string }>;
  input(sessionId: string, input: ScreenInput): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}
export class DesktopScreenProvider implements ScreenProvider {
  readonly kind = "desktop" as const;
  constructor(private readonly backend: DesktopSessionBackend, private readonly streamingAvailable = false) {}
  async create(agentId: string) { return { sessionId: await this.backend.createSession(agentId), delivery: this.streamingAvailable ? "stream" as const : "snapshot" as const }; }
  capture(sessionId: string) { return this.backend.screenshot(sessionId); }
  input(sessionId: string, input: ScreenInput) { return this.backend.input(sessionId, input); }
  close(sessionId: string) { return this.backend.closeSession(sessionId); }
}
