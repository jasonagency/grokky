import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { UpdateBanner } from "../src/renderer/src/features/updates/UpdateBanner";

describe("UpdateBanner", () => {
  test("names every restart blocker without navigating or replacing application context", () => {
    const markup = renderToStaticMarkup(<UpdateBanner update={{
      status: "blocked",
      channel: "stable",
      info: {
        version: "2.0.0",
        channel: "stable",
        releaseUrl: "https://github.com/jasonagency/grokky/releases/tag/v2.0.0",
        files: [{ url: "https://github.com/jasonagency/grokky/releases/download/v2.0.0/PuckBot.dmg", sha512: Buffer.alloc(64).toString("base64") }],
      },
      blockers: ["1 local conversation is still running", "1 operator approval is pending"],
    }} />);

    expect(markup).toContain("safe checkpoint");
    expect(markup).toContain("1 local conversation is still running");
    expect(markup).toContain("1 operator approval is pending");
    expect(markup).toContain("Release details");
    expect(markup).toContain("Restart to update");
    expect(markup).not.toContain("href=");
  });

  test("stays absent while idle so it does not disturb the composer", () => {
    expect(renderToStaticMarkup(<UpdateBanner update={{ status: "idle", channel: "stable", blockers: [] }} />)).toBe("");
  });
});
