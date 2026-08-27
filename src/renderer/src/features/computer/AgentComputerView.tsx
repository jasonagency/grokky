import type { AgentScreenSnapshot, ScreenLease } from "../../../../shared/remote-protocol";
import { TakeoverControls } from "./TakeoverControls";

export function AgentComputerView({ screens, busy, onAction }: { screens: AgentScreenSnapshot; busy?: string; onAction(lease: ScreenLease, action: "takeover" | "return" | "lock"): void }) {
  return <section className="computer-section agent-computer-view" aria-label="Agent computer sessions">
    <header><div><span>Shared computer</span><h4>Per-agent screens</h4><p>Each agent has a separate screen lease, but all sessions share one user-scoped trust boundary and may share approved browser logins.</p></div><strong>NOT SECURITY ISOLATION</strong></header>
    <div className="agent-screen-list">{screens.leases.filter((lease) => lease.status !== "revoked" && lease.status !== "expired").map((lease) => <article key={lease.id}><span className="screen-preview"><i>{lease.delivery === "stream" ? "LIVE" : "SNAPSHOT"}</i><b>{lease.kind}</b></span><span><strong>{lease.agentId}</strong><small>{lease.controller} control · epoch {lease.epoch} · {lease.status}</small></span><TakeoverControls lease={lease} busy={busy === lease.id} onTakeover={() => onAction(lease, "takeover")} onReturn={() => onAction(lease, "return")} onLock={() => onAction(lease, "lock")} /></article>)}
      {!screens.leases.some((lease) => lease.status === "active" || lease.status === "paused") && <p>No active agent screens. A remote browser or desktop task will create a lease here.</p>}
    </div>
  </section>;
}
