import { randomUUID } from "node:crypto";
import type { AgentMemory } from "../../shared/contracts";
import type { TeamRepository } from "./agent-runtime-service";

export class MemoryService {
  constructor(private readonly repository: TeamRepository, private readonly now = Date.now) {}
  list(agentId: string, options: { includeUnreviewed?: boolean } = {}): AgentMemory[] {
    return this.repository.snapshot().memories.filter((memory) => memory.agentId === agentId && (options.includeUnreviewed || memory.reviewStatus === "reviewed"));
  }
  async propose(input: Pick<AgentMemory, "agentId" | "kind" | "content" | "sourceReferences">): Promise<AgentMemory> {
    const memory: AgentMemory = { ...structuredClone(input), id: `memory:${randomUUID()}`, reviewStatus: "proposed", createdAt: this.now() };
    await this.repository.mutate((state) => { state.memories.push(memory); });
    return structuredClone(memory);
  }
  async review(id: string, decision: "reviewed" | "rejected"): Promise<AgentMemory> {
    let result!: AgentMemory;
    await this.repository.mutate((state) => {
      const memory = state.memories.find((item) => item.id === id);
      if (!memory) throw new Error("Agent memory was not found");
      memory.reviewStatus = decision;
      memory.reviewedAt = this.now();
      result = structuredClone(memory);
    });
    return result;
  }
}
