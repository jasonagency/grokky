import { useState } from "react";
import type { ControlCommand, TaskControlRequest, TaskNode } from "../../../../shared/control-plane-contracts";

export function LiveControls({ task, commands, busy, onControl }: {
  task?: TaskNode;
  commands: ControlCommand[];
  busy?: boolean;
  onControl(control: TaskControlRequest): Promise<void> | void;
}) {
  const [message, setMessage] = useState("");
  if (!task) return null;
  const taskCommands = commands.filter((command) => command.taskId === task.id).slice(-4).reverse();
  const send = (control: Omit<TaskControlRequest, "idempotencyKey">) => onControl({ ...control, idempotencyKey: `control-${crypto.randomUUID()}` });
  return (
    <section className="live-controls" aria-label="Live steering controls">
      <header><h4>Live steering</h4><span>{task.status}</span></header>
      <div className="live-control-buttons">
        <button type="button" disabled={busy || task.status === "paused"} onClick={() => void send({ type: "pause" })}>Pause</button>
        <button type="button" disabled={busy || task.status !== "paused"} onClick={() => void send({ type: "resume" })}>Resume</button>
        {task.assignment.targetHostId && <button type="button" disabled={busy || task.status !== "running"} onClick={() => void send({ type: "approve" })}>Approve host step</button>}
        <button type="button" disabled={busy || new Set(["succeeded", "failed", "canceled"]).has(task.status)} onClick={() => void send({ type: "stop" })}>Stop</button>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); if (message.trim()) { void send({ type: "redirect", message: message.trim() }); setMessage(""); } }}>
        <label htmlFor={`redirect-${task.id}`}>Redirect or follow up</label>
        <div><input id={`redirect-${task.id}`} value={message} maxLength={2_000} onChange={(event) => setMessage(event.target.value)} /><button type="submit" disabled={busy || !message.trim()}>Send</button></div>
      </form>
      {taskCommands.length > 0 && <ol className="control-delivery-list">{taskCommands.map((command) => <li key={command.id}><span>{command.type}</span><strong className={`delivery-${command.status}`}>{command.status}</strong>{command.detail && <small>{command.detail}</small>}</li>)}</ol>}
    </section>
  );
}
