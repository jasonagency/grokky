import { randomUUID } from "node:crypto";
import type { ControlRuntimeSnapshot, NotificationInput, NotificationRecord } from "../../shared/control-plane-contracts";
import { ControlRuntimeRepository, type ControlRuntimeStore } from "./control-runtime-repository";

export interface NotificationAdapter { show(record: Omit<NotificationRecord, "delivery">): Promise<boolean> }

export class NotificationService {
  private readonly repository: ControlRuntimeRepository;

  constructor(store: ControlRuntimeStore | ControlRuntimeRepository, private readonly adapter: NotificationAdapter, private readonly now: () => number = Date.now) {
    this.repository = store instanceof ControlRuntimeRepository ? store : new ControlRuntimeRepository(store);
  }

  initialize(): Promise<void> { return this.repository.initialize(); }
  snapshot(): ControlRuntimeSnapshot { return this.repository.snapshot(); }

  async notify(input: NotificationInput): Promise<NotificationRecord> {
    const base = { ...structuredClone(input), id: `notification:${randomUUID()}`, ...(input.taskId ? { deepLink: `puckbot://tasks/${encodeURIComponent(input.taskId)}` } : {}), createdAt: this.now() };
    const shown = await this.adapter.show(base);
    const record: NotificationRecord = { ...base, delivery: shown ? "os" : "in-app" };
    await this.repository.mutate((value) => { value.notifications.push(record); });
    return structuredClone(record);
  }
}
