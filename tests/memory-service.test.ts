import { describe, expect, test } from "vitest";
import { TeamRepository } from "../src/main/team/agent-runtime-service";
import { MemoryService } from "../src/main/team/memory-service";
import { teamStore } from "./support/team-store";

describe("MemoryService", () => {
  test("keeps proposed memory out of authoritative context until operator review", async () => {
    const repository = new TeamRepository(teamStore().database);
    await repository.initialize();
    const memories = new MemoryService(repository, () => 7);
    const proposed = await memories.propose({ agentId: "agent:a", kind: "fact", content: "The test command is npm test", sourceReferences: ["package.json"] });
    expect(memories.list("agent:a")).toEqual([]);
    expect(memories.list("agent:a", { includeUnreviewed: true })).toHaveLength(1);
    await memories.review(proposed.id, "reviewed");
    expect(memories.list("agent:a")[0]).toMatchObject({ reviewStatus: "reviewed", sourceReferences: ["package.json"] });
  });
});
