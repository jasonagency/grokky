import type { AgentMailboxMessage } from "../../../../shared/contracts";

export function MailboxView({ agentId, messages, onAcknowledge }: { agentId: string; messages: AgentMailboxMessage[]; onAcknowledge(id: string): void }) {
  const visible = messages.filter((message) => message.senderId === agentId || message.receiverIds.includes(agentId));
  return <section className="team-subpanel" aria-label="Agent mailbox"><header><strong>Mailbox</strong><small>{visible.length} messages</small></header><div className="mailbox-list">
    {visible.map((message) => <article key={message.id}><span><strong>{message.kind === "handoff" ? "Task handoff" : message.kind}</strong><small>{message.senderId} → {message.receiverIds.join(", ")}</small><p>{message.content}</p></span>{message.receiverIds.includes(agentId) && !message.acknowledgedBy.includes(agentId) && <button type="button" onClick={() => onAcknowledge(message.id)}>Acknowledge</button>}</article>)}
    {!visible.length && <p>No messages for this teammate yet.</p>}
  </div></section>;
}
