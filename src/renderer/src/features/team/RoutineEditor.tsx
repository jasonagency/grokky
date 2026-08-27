import { useState } from "react";
import type { AgentRoutine } from "../../../../shared/contracts";

export function RoutineEditor({ agentId, routines, onCreate }: { agentId: string; routines: AgentRoutine[]; onCreate(input: { name: string; localTime: string; timeZone: string }): void }) {
  const [name, setName] = useState("");
  const [localTime, setLocalTime] = useState("09:00");
  const mine = routines.filter((routine) => routine.ownerAgentId === agentId);
  return <section className="team-subpanel" aria-label="Agent routines"><header><strong>Routines</strong><small>{mine.length} scheduled</small></header>
    <div className="routine-list">{mine.map((routine) => <article key={routine.id}><span><strong>{routine.name}</strong><small>{routine.schedule.localTime} · {routine.schedule.timeZone}</small></span><em>{routine.active ? "active" : "paused"}</em></article>)}</div>
    <form className="routine-create" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onCreate({ name: name.trim(), localTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }); }}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="New routine" aria-label="Routine name" /><input type="time" value={localTime} onChange={(event) => setLocalTime(event.target.value)} aria-label="Routine time" /><button type="submit" disabled={!name.trim()}>Schedule</button></form>
  </section>;
}
