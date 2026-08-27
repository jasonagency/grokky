import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AttentionCenter } from "../src/renderer/src/features/tasks/AttentionCenter";

describe("attention center", () => {
  test("renders notification task targets as controls", () => {
    const markup = renderToStaticMarkup(<AttentionCenter onSelectTask={() => undefined} notifications={[{ id: "notice", type: "budget-pause", title: "Budget paused", body: "Review limits", taskId: "task", delivery: "in-app", deepLink: "puckbot://tasks/task", createdAt: 1 }]} />);
    expect(markup).toContain('aria-label="Attention center"');
    expect(markup).toContain("Budget paused");
    expect(markup).toContain("<button");
  });
});
