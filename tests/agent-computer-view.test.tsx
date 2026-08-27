import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AgentComputerView } from "../src/renderer/src/features/computer/AgentComputerView";

describe("AgentComputerView", () => {
  test("renders per-agent leases with an honest shared trust boundary and takeover controls", () => {
    const markup = renderToStaticMarkup(<AgentComputerView onAction={() => undefined} screens={{ audit: [], history: [], leases: [{ id: "lease", agentId: "researcher", providerSessionId: "page", kind: "browser", epoch: 1, controller: "agent", status: "active", delivery: "snapshot", sharedTrustBoundary: true, acquiredAt: 1, expiresAt: 2 }] }} />);
    expect(markup).toContain("Per-agent screens"); expect(markup).toContain("NOT SECURITY ISOLATION"); expect(markup).toContain("Take over"); expect(markup).toContain("SNAPSHOT");
  });
});
