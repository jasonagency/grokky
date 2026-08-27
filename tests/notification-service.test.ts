import { describe, expect, test } from "vitest";
import { NotificationService, type NotificationAdapter } from "../src/main/control-plane/notification-service";
import { MemoryRuntimeStore } from "./support/control-runtime-store";

describe("notification service", () => {
  test("falls back to attention center and retains a task deep link", async () => {
    const adapter: NotificationAdapter = { show: async () => false };
    const store = new MemoryRuntimeStore();
    const service = new NotificationService(store, adapter, () => 100);
    await service.initialize();

    const record = await service.notify({ type: "integration-conflict", title: "Integration needs attention", body: "Resolve src/app.ts", taskId: "task-1" });

    expect(record).toMatchObject({ delivery: "in-app", taskId: "task-1", deepLink: "puckbot://tasks/task-1" });
    expect(service.snapshot().notifications).toHaveLength(1);
  });
});
