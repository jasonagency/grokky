import { randomUUID } from "node:crypto";
import type { AgentDefinition, PersistentAgentRuntime, TeamStateSnapshot } from "../../shared/contracts";
import type { ControlPlaneDatabase } from "../storage/database-types";
import { agentRoleFingerprint } from "../agents";

const EMPTY_TEAM: TeamStateSnapshot = { revision: 0, agents: [], messages: [], memories: [], routines: [] };

export class TeamRepository {
  private state: TeamStateSnapshot = structuredClone(EMPTY_TEAM);
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly database: Pick<ControlPlaneDatabase, "readTeamState" | "writeTeamState">) {}

  async initialize(): Promise<void> {
    const stored = await this.database.readTeamState();
    this.state = stored ? JSON.parse(stored) as TeamStateSnapshot : structuredClone(EMPTY_TEAM);
  }

  snapshot(): TeamStateSnapshot { return structuredClone(this.state); }

  mutate<T>(operation: (state: TeamStateSnapshot) => T | Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const candidate = structuredClone(this.state);
      const value = await operation(candidate);
      candidate.revision += 1;
      await this.database.writeTeamState(JSON.stringify(candidate));
      this.state = candidate;
      return value;
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class AgentRuntimeService {
  constructor(readonly repository: TeamRepository, private readonly now = Date.now) {}
  initialize(): Promise<void> { return this.repository.initialize(); }
  snapshot(): TeamStateSnapshot { return this.repository.snapshot(); }

  async importDefinitions(definitions: AgentDefinition[]): Promise<PersistentAgentRuntime[]> {
    await this.repository.mutate((state) => {
      for (const profile of definitions) {
        const existing = state.agents.find((agent) => agent.id === profile.id);
        if (existing) {
          existing.profile = structuredClone(profile);
          existing.profileHash = agentRoleFingerprint(profile);
          existing.updatedAt = this.now();
        } else {
          const createdAt = this.now();
          state.agents.push({ id: profile.id, profile: structuredClone(profile), profileHash: agentRoleFingerprint(profile), status: "active", pinned: false, sessionReferences: {}, notificationPolicy: "attention", createdAt, updatedAt: createdAt });
        }
      }
    });
    return this.repository.snapshot().agents;
  }

  async rememberSession(agentId: string, harnessId: string, sessionReference: string, mailboxCursor?: string): Promise<void> {
    await this.repository.mutate((state) => {
      const agent = state.agents.find((item) => item.id === agentId);
      if (!agent || agent.status === "deleted") throw new Error("Persistent agent was not found");
      agent.harnessPreference = harnessId;
      agent.sessionReferences[harnessId] = sessionReference;
      if (mailboxCursor) agent.mailboxCursor = mailboxCursor;
      agent.updatedAt = this.now();
    });
  }

  async duplicate(agentId: string, newName: string): Promise<PersistentAgentRuntime> {
    let created!: PersistentAgentRuntime;
    await this.repository.mutate((state) => {
      const source = state.agents.find((item) => item.id === agentId);
      if (!source || source.status === "deleted") throw new Error("Persistent agent was not found");
      const now = this.now();
      const id = `agent:${randomUUID()}`;
      const profile = { ...structuredClone(source.profile), id, name: newName, builtIn: false, scope: "personal" as const };
      created = { ...structuredClone(source), id, profile, profileHash: agentRoleFingerprint(profile), status: "active", pinned: false, sessionReferences: {}, mailboxCursor: undefined, createdAt: now, updatedAt: now };
      state.agents.push(created);
      for (const routine of state.routines.filter((item) => item.ownerAgentId === agentId)) {
        state.routines.push({ ...structuredClone(routine), id: `routine:${randomUUID()}`, ownerAgentId: id, version: 1, lastOccurrenceKey: undefined, createdAt: now, updatedAt: now });
      }
    });
    return structuredClone(created);
  }

  async setStatus(agentId: string, status: PersistentAgentRuntime["status"]): Promise<{ warning?: string }> {
    await this.repository.mutate((state) => {
      const agent = state.agents.find((item) => item.id === agentId);
      if (!agent) throw new Error("Persistent agent was not found");
      agent.status = status;
      agent.updatedAt = this.now();
      if (status === "deleted") for (const routine of state.routines.filter((item) => item.ownerAgentId === agentId)) routine.active = false;
    });
    return status === "deleted" ? { warning: "Shared files, browser logins, and computer residue may remain on the host." } : {};
  }

  async setPinned(agentId: string, pinned: boolean): Promise<void> {
    await this.repository.mutate((state) => {
      const agent = state.agents.find((item) => item.id === agentId);
      if (!agent || agent.status === "deleted") throw new Error("Persistent agent was not found");
      agent.pinned = pinned;
      agent.updatedAt = this.now();
    });
  }
}
