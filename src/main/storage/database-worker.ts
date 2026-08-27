import { parentPort, workerData } from "node:worker_threads";
import { prepareWorkerDatabase } from "./database-client";
import type { DatabaseRequest, DatabaseResponse } from "./database-types";

const port = parentPort;
if (!port) throw new Error("Database worker requires a parent port");
const pathname = (workerData as { pathname?: unknown }).pathname;
if (typeof pathname !== "string" || !pathname) throw new Error("Database worker requires a database path");

const database = await prepareWorkerDatabase(pathname);

port.on("message", (request: DatabaseRequest) => {
  let response: DatabaseResponse;
  try {
    const command = request.command;
    if (command.type === "initialize") response = { id: request.id, ok: true };
    else if (command.type === "read_snapshot") response = { id: request.id, ok: true, value: database.readSnapshot() };
    else if (command.type === "write_snapshot") {
      database.writeSnapshot(command.snapshot);
      response = { id: request.id, ok: true };
    } else if (command.type === "import_legacy_snapshot") {
      response = { id: request.id, ok: true, value: database.importLegacySnapshot(command.snapshot, command.source, command.importedAt) };
    } else if (command.type === "inspect") response = { id: request.id, ok: true, value: database.inspect() };
    else {
      database.close();
      response = { id: request.id, ok: true };
    }
  } catch (error) {
    response = { id: request.id, ok: false, error: error instanceof Error ? error.message : "Database request failed" };
  }
  port.postMessage(response);
});
