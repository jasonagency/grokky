import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.env.GROKKY_LIVE_REMOTE_HOST !== "1") throw new Error("Set GROKKY_LIVE_REMOTE_HOST=1 to run the credentialed remote-host smoke");

const directory = await mkdtemp(join(tmpdir(), "grokky-live-remote-host-"));
const workspace = join(directory, "workspace");
const runnerState = join(directory, "runner.json");
const hostState = join(directory, "host.json");
await mkdir(workspace);
const runner = spawn(process.execPath, [resolve("out/main/runner-service.js"), "--root", workspace, "--state", runnerState, "--agent-state", hostState, "--host", "127.0.0.1", "--port", "0", "--allow-write", "--allow-commands", "--agent-host"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
let output = ""; let errors = "";
runner.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-20_000); });
runner.stderr.on("data", (chunk) => { errors = `${errors}${chunk}`.slice(-20_000); });

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise((resolvePromise) => setTimeout(resolvePromise, 100)); }
  throw new Error(`Timed out waiting for ${label}${errors ? `: ${errors.slice(-2_000)}` : ""}`);
}

async function post(endpoint, pathname, token, body) {
  const response = await fetch(`${endpoint}${pathname}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const payload = await response.json(); if (!response.ok) throw new Error(payload.error || `Remote host returned HTTP ${response.status}`); return payload;
}

try {
  const ready = await waitFor(async () => {
    const endpoint = output.match(/Endpoint:\s*(http:\/\/\S+)/)?.[1]; const code = output.match(/Pairing code:\s*(\d{6})/)?.[1];
    return endpoint && code ? { endpoint, code } : undefined;
  }, 30_000, "runner startup");
  const health = await (await fetch(`${ready.endpoint}/health`)).json();
  const capabilities = health.hostCapabilities?.agent;
  if (!capabilities) throw new Error("Runner did not advertise the agent-host capability");
  const preferred = process.env.GROKKY_REMOTE_HARNESS;
  const harnessId = preferred || ["codex-app-server", "codex-sdk", "pi-native", "openrouter-chat"].find((id) => capabilities.harnesses.includes(id));
  if (!harnessId || !capabilities.harnesses.includes(harnessId)) {
    const detail = (capabilities.harnessReadiness || []).map((entry) => `${entry.id}: ${entry.detail}`).join("; ");
    throw new Error(`No requested host harness is ready${detail ? ` (${detail})` : ""}`);
  }
  const pairing = await post(ready.endpoint, "/pair", "", { code: ready.code });
  const model = process.env.GROKKY_REMOTE_MODEL || (harnessId.startsWith("codex") ? "gpt-5.4" : harnessId === "pi-native" ? "openai/gpt-5.2" : "openai/gpt-5.2");
  const marker = `remote-host-proof-${Date.now()}`;
  const job = { id: "live-remote-job", idempotencyKey: marker, taskId: "live-remote-task", attemptId: "live-remote-attempt", leaseEpoch: 1, harnessId, approvalPolicy: "allow", budgetUsd: 5, payload: { prompt: `Create a file named remote-proof.txt in the current workspace containing exactly: ${marker}\nThen reply with a short completion summary.`, model, reasoning: "medium", sandboxMode: "workspace-write", allowCommands: true } };
  await post(ready.endpoint, "/host/jobs", pairing.token, { job });

  // Deliberately make no client requests while the host owns and executes the task.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));

  let cursor = 0;
  const terminal = await waitFor(async () => {
    const result = await post(ready.endpoint, "/host/events", pairing.token, { afterCursor: cursor, limit: 500 });
    for (const event of result.events) cursor = Math.max(cursor, event.cursor);
    return result.events.find((event) => event.jobId === job.id && new Set(["job.completed", "job.failed", "job.canceled"]).has(event.type));
  }, 5 * 60_000, "remote task completion");
  if (terminal.type !== "job.completed") throw new Error(`Remote task ended with ${terminal.type}: ${JSON.stringify(terminal.payload).slice(0, 2_000)}`);
  const content = await readFile(join(workspace, "remote-proof.txt"), "utf8");
  if (content.trim() !== marker) throw new Error("Remote host output file did not match the requested marker");
  process.stdout.write(`Remote host smoke passed with ${harnessId} while no Electron desktop process was running.\n`);
} finally {
  runner.kill("SIGTERM");
  await new Promise((resolvePromise) => { if (runner.exitCode !== null) resolvePromise(); else { runner.once("close", resolvePromise); setTimeout(resolvePromise, 5_000); } });
  await rm(directory, { recursive: true, force: true });
}
