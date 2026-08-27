import type { ScreenInput } from "../shared/remote-protocol";
import type { ScreenProvider } from "./screen-session-manager";
import type { BrowserSessionBroker } from "./browser-session-broker";

export class BrowserScreenProvider implements ScreenProvider {
  readonly kind = "browser" as const;
  constructor(private readonly broker: BrowserSessionBroker, private readonly streamingAvailable = true) {}
  async create(agentId: string) { return { sessionId: await this.broker.create(agentId), delivery: this.streamingAvailable ? "stream" as const : "snapshot" as const }; }
  capture(sessionId: string) { return this.broker.capture(sessionId); }
  input(sessionId: string, input: ScreenInput) { return this.broker.input(sessionId, input); }
  close(sessionId: string) { return this.broker.close(sessionId); }
}
