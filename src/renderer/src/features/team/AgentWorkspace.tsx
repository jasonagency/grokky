import { useState } from "react";
import type { TeamStateSnapshot } from "../../../../shared/contracts";
import { MailboxView } from "./MailboxView";
import { RoutineEditor } from "./RoutineEditor";

export function AgentWorkspace({ team, onAcknowledge, onReviewMemory, onCreateRoutine, onAgentAction, onDuplicate }: {
  team: TeamStateSnapshot;
  onAcknowledge(messageId: string, agentId: string): void;
  onReviewMemory(memoryId: string, decision: "reviewed" | "rejected"): void;
  onCreateRoutine(agentId: string, input: { name: string; localTime: string; timeZone: string }): void;
  onAgentAction(agentId: string, action: "pin" | "unpin" | "hide" | "archive" | "restore" | "delete"): void;
  onDuplicate(agentId: string, name: string): void;
}) {
  const visible = team.agents.filter((agent) => agent.status !== "deleted").sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.profile.name.localeCompare(right.profile.name));
  const [selectedId, setSelectedId] = useState(visible[0]?.id ?? "");
  const selected = visible.find((agent) => agent.id === selectedId) ?? visible[0];
  if (!selected) return <section className="agent-workspace" aria-label="Persistent agent workspace"><p>No persistent teammates have been imported.</p></section>;
  const memories = team.memories.filter((memory) => memory.agentId === selected.id);
  return <section className="agent-workspace" aria-label="Persistent agent workspace">
    <header><div><span>Persistent team</span><h4>{selected.profile.name}</h4><p>{selected.profile.description}</p></div><em>{selected.harnessPreference ?? "No active harness session"}</em></header>
    <div className="agent-lifecycle-controls"><button type="button" onClick={() => onAgentAction(selected.id, selected.pinned ? "unpin" : "pin")}>{selected.pinned ? "Unpin" : "Pin"}</button>{selected.status === "active" ? <><button type="button" onClick={() => onAgentAction(selected.id, "hide")}>Hide</button><button type="button" onClick={() => onAgentAction(selected.id, "archive")}>Archive</button></> : <button type="button" onClick={() => onAgentAction(selected.id, "restore")}>Restore {selected.status}</button>}<button type="button" onClick={() => onDuplicate(selected.id, `${selected.profile.name}_copy`)}>Duplicate</button><button type="button" onClick={() => onAgentAction(selected.id, "delete")}>Delete</button></div>
    <div className="persistent-agent-tabs" role="tablist" aria-label="Persistent teammates">{visible.map((agent) => <button type="button" role="tab" aria-selected={agent.id === selected.id} key={agent.id} onClick={() => setSelectedId(agent.id)}>{agent.pinned ? "◆ " : ""}{agent.profile.name}{agent.status !== "active" ? ` · ${agent.status}` : ""}</button>)}</div>
    <div className="agent-workspace-grid"><MailboxView agentId={selected.id} messages={team.messages} onAcknowledge={(id) => onAcknowledge(id, selected.id)} /><section className="team-subpanel" aria-label="Agent memory"><header><strong>Reviewable memory</strong><small>{memories.length} entries</small></header>{memories.map((memory) => <article key={memory.id}><span><strong>{memory.kind}</strong><p>{memory.content}</p><small>{memory.sourceReferences.join(" · ")}</small></span>{memory.reviewStatus === "proposed" && <span className="memory-actions"><button type="button" onClick={() => onReviewMemory(memory.id, "rejected")}>Reject</button><button type="button" onClick={() => onReviewMemory(memory.id, "reviewed")}>Review</button></span>}</article>)}</section></div>
    <RoutineEditor agentId={selected.id} routines={team.routines} onCreate={(input) => onCreateRoutine(selected.id, input)} />
  </section>;
}
