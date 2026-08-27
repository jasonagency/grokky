import { spawn } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

const [platform, arch] = process.argv.slice(2);
const requireSigned = process.env.GROKKY_REQUIRE_SIGNED === "1";
const platformConfig = platform === "darwin" && arch === "arm64"
  ? {
      resources: join(process.cwd(), "release", "mac-arm64", "Grokky.app", "Contents", "Resources"),
      packageName: "codex-darwin-arm64",
      vendorPlatform: "aarch64-apple-darwin",
      executable: "codex",
    }
  : platform === "win32" && arch === "x64"
    ? {
        resources: join(process.cwd(), "release", "win-unpacked", "resources"),
        packageName: "codex-win32-x64",
        vendorPlatform: "x86_64-pc-windows-msvc",
        executable: "codex.exe",
      }
    : undefined;

if (!platformConfig) {
  throw new Error("Usage: node scripts/check-packaged-codex.mjs <darwin arm64|win32 x64>");
}

const executablePath = join(
  platformConfig.resources,
  "app.asar.unpacked",
  "node_modules",
  "@openai",
  platformConfig.packageName,
  "vendor",
  platformConfig.vendorPlatform,
  "bin",
  platformConfig.executable,
);

await access(executablePath, constants.R_OK);
const info = await stat(executablePath);
if (!info.isFile() || info.size < 1_000_000) throw new Error(`Bundled Codex executable is invalid: ${executablePath}`);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed with status ${code ?? "unknown"}`)));
  });
}

async function requireUpdaterMetadata() {
  const releaseDirectory = join(process.cwd(), "release");
  const packageVersion = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")).version;
  const beta = /-beta(?:\.|$)/.test(packageVersion);
  const expectedName = platform === "darwin" ? (beta ? "beta-mac.yml" : "latest-mac.yml") : (beta ? "beta.yml" : "latest.yml");
  const metadataPath = join(releaseDirectory, expectedName);
  const metadata = await readFile(metadataPath, "utf8");
  if (!new RegExp(`^version:\\s*["']?${packageVersion.replaceAll(".", "\\.")}["']?\\s*$`, "m").test(metadata)) {
    throw new Error(`${expectedName} does not identify package version ${packageVersion}`);
  }
  if (!/^\s*sha512:\s*[A-Za-z0-9+/]+={0,2}\s*$/m.test(metadata)) throw new Error(`${expectedName} has no SHA-512 artifact digest`);
  if (!/^\s*(?:url|path):\s*\S+/m.test(metadata)) throw new Error(`${expectedName} has no update artifact path`);
}

async function verifySignedPackage() {
  await requireUpdaterMetadata();
  const releaseDirectory = join(process.cwd(), "release");
  const files = await readdir(releaseDirectory);
  if (platform === "darwin") {
    const appPath = join(releaseDirectory, "mac-arm64", "Grokky.app");
    const dmg = files.find((name) => name.endsWith(".dmg"));
    if (!dmg) throw new Error("Signed macOS release has no DMG");
    await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
    await run("codesign", ["--verify", "--strict", "--verbose=2", executablePath]);
    await run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
    await run("xcrun", ["stapler", "validate", appPath]);
    await run("xcrun", ["stapler", "validate", join(releaseDirectory, dmg)]);
  } else {
    const installer = files.find((name) => name.endsWith(".exe") && !name.endsWith(".blockmap"));
    if (!installer) throw new Error("Signed Windows release has no installer");
    const verify = "$s=Get-AuthenticodeSignature -LiteralPath $args[0]; if ($s.Status -ne 'Valid') { Write-Error ($s.Status.ToString() + ': ' + $s.StatusMessage); exit 1 }";
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", verify, join(releaseDirectory, installer)]);
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", verify, executablePath]);
  }
}

if (requireSigned) await verifySignedPackage();

process.stdout.write(`Packaged Codex runtime${requireSigned ? ", updater metadata, and native signatures" : ""} verified (${info.size.toLocaleString()} bytes).\n`);
