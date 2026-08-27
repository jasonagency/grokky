import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { EvalDashboard } from "../src/renderer/src/features/evaluations/EvalDashboard";

describe("EvalDashboard", () => {
  test("renders versioned cases and independently inspectable grader counts", () => {
    const markup = renderToStaticMarkup(<EvalDashboard onCompare={() => undefined} state={{ revision: 1, runs: [], cases: [{ id: "case", version: 2, name: "Cross-harness coding", sourceTraceHash: "hash", frozenTrace: { query: {}, events: [], generatedAt: 1 }, expectedOutcome: "done", allowedSideEffects: [], verificationRules: [{ type: "no-policy-violations" }], createdAt: 1 }] }} />);
    expect(markup).toContain('aria-label="Evaluation dashboard"');
    expect(markup).toContain("Cross-harness coding");
    expect(markup).toContain("v2 · 1 deterministic checks");
  });
});
