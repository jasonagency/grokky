import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const chromiumPath = process.env.GROKKY_CHROMIUM_PATH;
if (!chromiumPath) throw new Error("Set GROKKY_CHROMIUM_PATH to a Chromium executable");
const directory = await mkdtemp(join(tmpdir(), "grokky-linux-screens-"));
const workspace = join(directory, "workspace"); const profile = join(directory, "chrome-profile"); await mkdir(workspace); await mkdir(profile);
const chromium = spawn(chromiumPath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=9222", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let chromeErrors = ""; chromium.stderr.on("data", (chunk) => { chromeErrors = `${chromeErrors}${chunk}`.slice(-10_000); });
const runner = spawn(process.execPath, [resolve("out/main/runner-service.js"), "--root", workspace, "--state", join(directory, "runner.json"), "--agent-state", join(directory, "host.json"), "--host", "127.0.0.1", "--port", "0", "--agent-host", "--browser-cdp", "http://127.0.0.1:9222"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
let output = ""; let runnerErrors = ""; runner.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-10_000); }); runner.stderr.on("data", (chunk) => { runnerErrors = `${runnerErrors}${chunk}`.slice(-10_000); });

async function waitFor(predicate, timeoutMs, label) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise((resolvePromise) => setTimeout(resolvePromise, 100)); } throw new Error(`Timed out waiting for ${label}: ${runnerErrors.slice(-1_000)} ${chromeErrors.slice(-1_000)}`); }
async function request(endpoint, pathname, token, body, expectedStatus = 200) { const response = await fetch(`${endpoint}${pathname}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }); const payload = await response.json(); if (response.status !== expectedStatus) throw new Error(payload.error || `Expected HTTP ${expectedStatus}, received ${response.status}`); return payload; }

try {
  await waitFor(async () => fetch("http://127.0.0.1:9222/json/version").then((response) => response.ok).catch(() => false), 30_000, "Chromium DevTools");
  const ready = await waitFor(async () => { const endpoint = output.match(/Endpoint:\s*(http:\/\/\S+)/)?.[1]; const code = output.match(/Pairing code:\s*(\d{6})/)?.[1]; return endpoint && code ? { endpoint, code } : undefined; }, 30_000, "screen host");
  const pairing = await request(ready.endpoint, "/pair", "", { code: ready.code });
  const first = (await request(ready.endpoint, "/host/screens/lease", pairing.token, { agentId: "agent:first", kind: "browser" })).lease;
  const second = (await request(ready.endpoint, "/host/screens/lease", pairing.token, { agentId: "agent:second", kind: "browser" })).lease;
  if (first.providerSessionId === second.providerSessionId) throw new Error("Browser agents received the same provider page");
  const firstFrame = (await request(ready.endpoint, "/host/screens/capture", pairing.token, { leaseId: first.id, epoch: first.epoch })).frame;
  const secondFrame = (await request(ready.endpoint, "/host/screens/capture", pairing.token, { leaseId: second.id, epoch: second.epoch })).frame;
  if (!firstFrame.data || !secondFrame.data) throw new Error("Browser screen capture returned no image data");
  await request(ready.endpoint, "/host/screens/input", pairing.token, { leaseId: first.id, epoch: first.epoch, agentId: "agent:second", input: { type: "click", x: 1, y: 1 } }, 500);
  const taken = (await request(ready.endpoint, "/host/screens/control", pairing.token, { leaseId: first.id, epoch: first.epoch, action: "takeover" })).lease;
  if (taken.controller !== "operator") throw new Error("Operator takeover was not recorded");
  await request(ready.endpoint, "/host/screens/operator-input", pairing.token, { leaseId: first.id, epoch: first.epoch, input: { type: "key", key: "Tab" } });
  const returned = (await request(ready.endpoint, "/host/screens/control", pairing.token, { leaseId: first.id, epoch: first.epoch, action: "return" })).lease;
  if (returned.controller !== "agent") throw new Error("Agent control was not restored");
  process.stdout.write("Linux browser concurrency, screen isolation, capture, and takeover smoke passed.\n");
} finally {
  runner.kill("SIGTERM"); chromium.kill("SIGTERM");
  await Promise.all([runner, chromium].map((child) => new Promise((resolvePromise) => { if (child.exitCode !== null) resolvePromise(); else { child.once("close", resolvePromise); setTimeout(resolvePromise, 5_000); } })));
  await rm(directory, { recursive: true, force: true });
}
