import { spawn } from "node:child_process";
import { join } from "node:path";

const [targetPlatform, targetArch, targetKind] = process.argv.slice(2);
const releaseBuild = process.argv.includes("--release") || process.env.GROKKY_RELEASE_BUILD === "1";

const targets = {
  "darwin:arm64:dir": {
    label: "Apple Silicon macOS application",
    hostPlatform: "darwin",
    builderArgs: ["--mac", "dir", "--arm64", "--publish", "never"],
  },
  "darwin:arm64:dmg": {
    label: "Apple Silicon macOS DMG",
    hostPlatform: "darwin",
    builderArgs: ["--mac", "dmg", "zip", "--arm64", "--publish", "never"],
  },
  "win32:x64:dir": {
    label: "Windows x64 application",
    hostPlatform: "win32",
    builderArgs: ["--win", "dir", "--x64", "--publish", "never"],
  },
  "win32:x64:nsis": {
    label: "Windows x64 NSIS installer",
    hostPlatform: "win32",
    builderArgs: ["--win", "nsis", "--x64", "--publish", "never"],
  },
};

const key = `${targetPlatform}:${targetArch}:${targetKind}`;
const target = targets[key];

if (!target) {
  throw new Error("Usage: node scripts/package-platform.mjs <darwin arm64 dir|dmg | win32 x64 dir|nsis>");
}

if (process.platform !== target.hostPlatform) {
  const hostName = target.hostPlatform === "darwin" ? "macOS" : "Windows";
  const ciRunner = target.hostPlatform === "darwin" ? "macos-14" : "windows-2022";
  throw new Error(
    `${target.label} must be built on ${hostName}. Electron cross-packaging can omit the target Codex runtime while still producing an app shell. Push to main to build and verify this target on the native ${ciRunner} GitHub runner.`,
  );
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `status ${code ?? "unknown"}`}`));
    });
  });
}

const npmCli = process.env.npm_execpath;
const electronBuilderCli = join(process.cwd(), "node_modules", "electron-builder", "cli.js");
const packageVerifier = join(process.cwd(), "scripts", "check-packaged-codex.mjs");

if (!npmCli) throw new Error("Package this application through its npm scripts so the npm CLI path is available");

function requireReleaseEnvironment(names) {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Signed release packaging is missing: ${missing.join(", ")}`);
}

if (releaseBuild) {
  requireReleaseEnvironment(targetPlatform === "darwin"
    ? ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_TEAM_ID"]
    : ["CSC_LINK", "CSC_KEY_PASSWORD", "WIN_PUBLISHER_NAME"]);
  const tag = process.env.GITHUB_REF_NAME;
  const version = process.env.npm_package_version;
  if (tag && version && tag !== `v${version}`) throw new Error(`Release tag ${tag} does not match package version v${version}`);
  target.builderArgs.push("-c.forceCodeSigning=true");
  if (targetPlatform === "win32") target.builderArgs.push(`-c.win.publisherName=${process.env.WIN_PUBLISHER_NAME}`);
}

await run(process.execPath, [npmCli, "run", "build"]);
await run(process.execPath, [electronBuilderCli, ...target.builderArgs]);
await run(process.execPath, [packageVerifier, targetPlatform, targetArch], {
  env: { ...process.env, ...(releaseBuild ? { GROKKY_REQUIRE_SIGNED: "1" } : {}) },
});

process.stdout.write(`${target.label} built and verified.\n`);
