import { CODEX_MODELS } from "../../shared/contracts";
import type { HarnessAdapter } from "./types";
import { runCodex } from "../providers/codex-provider";
import type { ProviderRunContext } from "../providers/types";
import { codexCredentialStatus } from "../credentials";

export type CodexCompatibilityRunner = (context: ProviderRunContext) => Promise<void>;

export class CodexSdkAdapter implements HarnessAdapter {
  readonly descriptor = {
    id: "codex-sdk",
    version: "compat-1",
    displayName: "Codex SDK",
    providerCompatibility: ["codex" as const],
    models: CODEX_MODELS.map((id) => ({ id, label: id })),
    capabilities: {
      sessionPersistence: true,
      streaming: true,
      steering: "none" as const,
      cancellation: true,
      tools: true,
      mcp: true,
      usage: "authoritative" as const,
      computerControl: true,
      multiAgent: true,
    },
  };

  constructor(private readonly runner: CodexCompatibilityRunner = runCodex) {}

  async health({ homeDirectory }: Parameters<HarnessAdapter["health"]>[0]) {
    const { id: _provider, ...health } = await codexCredentialStatus(homeDirectory);
    return health;
  }

  run(context: ProviderRunContext): Promise<void> {
    return this.runner(context);
  }

  async deliverControl() {
    return { accepted: false, reason: "The Codex SDK compatibility adapter supports cancellation through its run signal only." };
  }

  async cleanup(): Promise<void> {}
}
