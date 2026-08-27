import { describe, expect, test } from "vitest";
import { CodexAppServerAdapter } from "../src/main/harnesses/codex-app-server-adapter";
import { CodexSdkAdapter } from "../src/main/harnesses/codex-sdk-adapter";

describe("Codex adapter parity", () => {
  test("App Server preserves SDK baseline capabilities and adds steering", () => {
    const appServer = new CodexAppServerAdapter();
    const sdk = new CodexSdkAdapter();
    for (const capability of ["sessionPersistence", "streaming", "cancellation", "tools", "mcp", "computerControl", "multiAgent"] as const) {
      expect(appServer.descriptor.capabilities[capability]).toBe(sdk.descriptor.capabilities[capability]);
    }
    expect(appServer.descriptor.capabilities.steering).toBe("mid-turn");
    expect(sdk.descriptor.capabilities.steering).toBe("none");
    expect(appServer.descriptor.compatibilityPriority).toBeGreaterThan(sdk.descriptor.compatibilityPriority);
  });
});
