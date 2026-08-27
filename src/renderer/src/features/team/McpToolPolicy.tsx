import { useState } from "react";
import type { McpCapability, McpToolClassification } from "../../../../shared/contracts";

const classifications: Array<{ value: McpToolClassification; label: string }> = [
  { value: "read", label: "Read-only" },
  { value: "write", label: "Workspace write" },
  { value: "external-side-effect", label: "External side effect" },
  { value: "human-only", label: "Human only" },
];

export function McpToolPolicy({
  server,
  busy,
  onClassify,
  onBeginAuthorization,
  onCompleteAuthorization,
  onRevokeAuthorization,
}: {
  server: McpCapability;
  busy: boolean;
  onClassify(name: string, classification: McpToolClassification): Promise<void>;
  onBeginAuthorization(): Promise<void>;
  onCompleteAuthorization(callback: string): Promise<void>;
  onRevokeAuthorization(): Promise<void>;
}) {
  const [callback, setCallback] = useState("");
  return (
    <div className="mcp-tool-policy">
      {server.status && <small className={`mcp-status ${server.status}`}>{server.status.replaceAll("-", " ")}{server.detail ? ` · ${server.detail}` : ""}</small>}
      {server.status === "authorization-required" && server.transport === "remote" && (
        <div className="mcp-auth-controls">
          <button type="button" disabled={busy} onClick={() => void onBeginAuthorization()}>Open authorization</button>
          <input value={callback} onChange={(event) => setCallback(event.target.value)} placeholder="Paste the complete callback URL" aria-label={`${server.name} authorization callback`} />
          <button type="button" disabled={busy || !callback.trim()} onClick={() => void onCompleteAuthorization(callback)}>Complete</button>
        </div>
      )}
      {server.status === "ready" && server.transport === "remote" && <button className="mcp-revoke" type="button" disabled={busy} onClick={() => void onRevokeAuthorization()}>Revoke saved OAuth token</button>}
      {(server.tools ?? []).map((tool) => (
        <label className="mcp-tool-row" key={tool.namespacedName}>
          <span><strong>{tool.name}</strong><small>{tool.description} · {tool.classificationSource.replaceAll("-", " ")}</small></span>
          <select value={tool.classification} disabled={busy} aria-label={`${tool.name} MCP policy`} onChange={(event) => void onClassify(tool.namespacedName, event.target.value as McpToolClassification)}>
            {classifications.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
      ))}
      {server.status === "ready" && !(server.tools ?? []).length && <small>This server advertises no tools.</small>}
    </div>
  );
}
