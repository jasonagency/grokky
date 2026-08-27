import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const [mode = "write", label = process.platform] = process.argv.slice(2);
const directory = join(process.cwd(), "release");

async function digest(pathname) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(pathname)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

if (mode === "write") {
  const names = (await readdir(directory))
    .filter((name) => /\.(?:dmg|zip|exe|blockmap|yml)$/i.test(name))
    .sort();
  if (!names.length) throw new Error("No release artifacts were found for checksumming");
  const rows = await Promise.all(names.map(async (name) => `${await digest(join(directory, name))}  ${name}`));
  const output = join(directory, `SHA256SUMS-${label}.txt`);
  await writeFile(output, `${rows.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${basename(output)} records ${names.length} release artifacts.\n`);
} else if (mode === "verify") {
  const manifests = (await readdir(directory)).filter((name) => /^SHA256SUMS-.+\.txt$/.test(name));
  if (!manifests.length) throw new Error("No checksum manifests were found");
  for (const manifest of manifests) {
    const rows = (await readFile(join(directory, manifest), "utf8")).trim().split("\n").filter(Boolean);
    for (const row of rows) {
      const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(row);
      if (!match) throw new Error(`Malformed checksum row in ${manifest}`);
      const actual = await digest(join(directory, match[2]));
      if (actual !== match[1]) throw new Error(`Checksum mismatch for ${match[2]}`);
    }
  }
  process.stdout.write(`${manifests.length} checksum manifest(s) verified.\n`);
} else {
  throw new Error("Usage: node scripts/release-checksums.mjs [write <label>|verify]");
}
