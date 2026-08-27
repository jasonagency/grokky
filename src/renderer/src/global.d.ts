import type { PuckBotApi } from "../../shared/contracts";

declare global {
  interface Window {
    grokky: PuckBotApi;
  }
}

export {};
