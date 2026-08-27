import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { WorkspaceLeasePanel } from "../src/renderer/src/features/tasks/WorkspaceLeasePanel";

describe("workspace lease panel", () => {
  test("shows isolation, recovery, and integration conflict state", () => {
    const markup = renderToStaticMarkup(<WorkspaceLeasePanel taskId="task" state={{
      revision: 2,
      leases: [{ id: "lease", taskId: "task", repositoryId: "repo", kind: "git", mode: "write", writable: true, workspace: "/repo", root: "/worktree", holderId: "verifier", status: "recovery", branch: "grokky/task-a", recoveryReason: "Dirty worktree retained", createdAt: 1, updatedAt: 2 }],
      integrations: [{ id: "integration", taskId: "task", repositoryId: "repo", taskBranch: "grokky/task-a", targetRef: "main", status: "conflict", conflictFiles: ["src/app.ts"], verification: [], createdAt: 1, updatedAt: 2 }],
    }} />);

    expect(markup).toContain('aria-label="Workspace lease"');
    expect(markup).toContain("Isolated Git worktree");
    expect(markup).toContain("Dirty worktree retained");
    expect(markup).toContain("src/app.ts");
  });
});
