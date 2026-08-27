import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = process.cwd();
const text = (pathname: string) => readFile(join(root, pathname), "utf8");

describe("signed release configuration", () => {
  test("requires hardened, notarized, update-capable native packages", async () => {
    const packageJson = JSON.parse(await text("package.json"));
    expect(packageJson.build.mac).toMatchObject({
      hardenedRuntime: true,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.plist",
      notarize: true,
    });
    expect(packageJson.build.mac.target).toEqual(expect.arrayContaining(["dmg", "zip"]));
    expect(packageJson.build.win.verifyUpdateCodeSignature).toBe(true);
    expect(packageJson.build.publish).toMatchObject({ provider: "github", owner: "jasonagency", repo: "grokky" });
    expect(packageJson.build.generateUpdatesFilesForAllChannels).toBe(true);
    expect(await text("build/entitlements.mac.plist")).toContain("com.apple.security.cs.allow-jit");
  });

  test("publishes only exact version tags with signatures, checksums, provenance, and rollback evidence", async () => {
    const workflow = await text(".github/workflows/release.yml");
    expect(workflow).toMatch(/tags: \["v\*"\]/);
    expect(workflow).toContain("Tag must exactly match package.json version");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("attestations: write");
    expect(workflow).toMatch(/actions\/attest@[a-f0-9]{40}/);
    expect(workflow).toContain("SHA256SUMS");
    expect(workflow).toContain("STABLE_ROLLBACK_EVIDENCE");
    expect(workflow).toContain("npm run release:mac");
    expect(workflow).toContain("npm run release:win");

    const packaging = await text("scripts/package-platform.mjs");
    expect(packaging).toContain("forceCodeSigning=true");
    expect(packaging).toContain("WIN_PUBLISHER_NAME");
    expect(packaging).toContain("GROKKY_REQUIRE_SIGNED");

    const verifier = await text("scripts/check-packaged-codex.mjs");
    expect(verifier).toContain("codesign");
    expect(verifier).toContain("stapler");
    expect(verifier).toContain("Get-AuthenticodeSignature");
    expect(verifier).toContain("latest-mac.yml");
    expect(verifier).toContain("beta-mac.yml");
    expect(verifier).toContain("SHA-512 artifact digest");
  });

  test("keeps unsigned CI artifacts distinct and documents clean install, migration recovery, and host rollback", async () => {
    const verify = await text(".github/workflows/verify.yml");
    expect(verify).toContain("Development package, unsigned");
    expect(verify).toContain("CSC_IDENTITY_AUTO_DISCOVERY");

    const releasing = await text("docs/RELEASING.md");
    expect(releasing).toContain("Clean-machine install and update smoke");
    expect(releasing).toContain("Desktop rollback drill");
    expect(releasing).toContain("conversations.sqlite3.pre-migration-backup");
    expect(releasing).toContain("Remote agent-host updates");
    expect(releasing).toMatch(/incompatible major skew blocks/i);

    const security = await text("docs/SECURITY.md");
    expect(security).toContain("Release and update trust");
    expect(security).toContain("does not replace failed state with an empty database");
  });
});
