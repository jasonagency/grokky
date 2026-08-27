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
    } else if (command.type === "read_task_graph") {
      response = { id: request.id, ok: true, value: database.readTaskGraph() };
    } else if (command.type === "write_task_graph") {
      database.writeTaskGraph(command.snapshot);
      response = { id: request.id, ok: true };
    } else if (command.type === "read_workspace_state") {
      response = { id: request.id, ok: true, value: database.readWorkspaceState() };
    } else if (command.type === "write_workspace_state") {
      database.writeWorkspaceState(command.snapshot);
      response = { id: request.id, ok: true };
    } else if (command.type === "read_control_runtime") {
      response = { id: request.id, ok: true, value: database.readControlRuntime() };
    } else if (command.type === "write_control_runtime") {
      database.writeControlRuntime(command.snapshot);
      response = { id: request.id, ok: true };
    } else if (command.type === "read_quality_state") {
      response = { id: request.id, ok: true, value: database.readQualityState() };
    } else if (command.type === "write_quality_state") {
      database.writeQualityState(command.snapshot);
      response = { id: request.id, ok: true };
    } else if (command.type === "read_team_state") {
      response = { id: request.id, ok: true, value: database.readTeamState() };
    } else if (command.type === "write_team_state") {
      database.writeTeamState(command.snapshot);
      response = { id: request.id, ok: true };
    } else if (command.type === "read_remote_state") {
      response = { id: request.id, ok: true, value: database.readRemoteState() };
    } else if (command.type === "write_remote_state") {
      database.writeRemoteState(command.snapshot);
      response = { id: request.id, ok: true };
    } else if (command.type === "import_legacy_snapshot") {
      response = { id: request.id, ok: true, value: database.importLegacySnapshot(command.snapshot, command.source, command.importedAt) };
    } else if (command.type === "append_event") {
      response = { id: request.id, ok: true, value: database.appendEvent(command.request) };
    } else if (command.type === "list_events") {
      response = { id: request.id, ok: true, value: database.listEvents() };
    } else if (command.type === "list_event_diagnostics") {
      response = { id: request.id, ok: true, value: database.listEventDiagnostics() };
    } else if (command.type === "list_conversation_projections") {
      response = { id: request.id, ok: true, value: database.listConversationProjections() };
    } else if (command.type === "read_event_artifact") {
      response = { id: request.id, ok: true, value: database.readEventArtifact(command.sha256) };
    } else if (command.type === "delete_expired_event_artifacts") {
      response = { id: request.id, ok: true, value: database.deleteExpiredEventArtifacts(command.now) };
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
