import type { HarnessAdapter } from "./types";
import { runOpenRouter } from "../providers/openrouter-provider";
import type { OpenRouterRunContext, ProviderRunContext } from "../providers/types";
import { resolveOpenRouterCredential } from "../credentials";

type Credential = { apiKey: string; source: string };
export type OpenRouterCompatibilityRunner = (context: OpenRouterRunContext) => Promise<void>;
export type OpenRouterCredentialResolver = (settings: ProviderRunContext["settings"], homeDirectory: string) => Promise<Credential | null>;

export class OpenRouterAdapter implements HarnessAdapter {
  readonly descriptor = {
    id: "openrouter-chat",
    version: "compat-2-mcp",
    displayName: "OpenRouter Chat",
    providerCompatibility: ["openrouter" as const],
    models: [{ id: "*", label: "OpenRouter model ID", dynamic: true }],
    capabilities: {
      sessionPersistence: false,
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

  constructor(
    private readonly homeDirectory: string,
    private readonly runner: OpenRouterCompatibilityRunner = runOpenRouter,
    private readonly credentialResolver: OpenRouterCredentialResolver = resolveOpenRouterCredential,
  ) {}

  async health({ settings }: Parameters<HarnessAdapter["health"]>[0]) {
    const credential = await this.credentialResolver(settings, this.homeDirectory);
    return {
      ready: Boolean(credential),
      label: credential ? "OpenRouter configured" : "OpenRouter key missing",
      source: credential?.source ?? "No credential source found",
      detail: credential ? "The key stays in the Electron main process." : "Choose an env file containing OPENROUTER_API_KEY.",
    };
  }

  async run(context: ProviderRunContext): Promise<void> {
    const credential = await this.credentialResolver(context.settings, this.homeDirectory);
    if (!credential) throw new Error("OpenRouter credential is unavailable");
    await this.runner({ ...context, apiKey: credential.apiKey });
  }

  async deliverControl() {
    return { accepted: false, reason: "The OpenRouter compatibility adapter supports cancellation through its run signal only." };
  }

  async cleanup(): Promise<void> {}
}
