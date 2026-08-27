import { randomUUID } from "node:crypto";
import type { ControlCommand, ControlCommandInput, ControlRuntimeSnapshot } from "../../shared/control-plane-contracts";
import type { HarnessControlResult } from "../../shared/harness-contracts";
import { ControlRuntimeRepository, type ControlRuntimeStore } from "./control-runtime-repository";

export type { ControlRuntimeStore } from "./control-runtime-repository";

export class SteeringService {
  readonly repository: ControlRuntimeRepository;

  constructor(store: ControlRuntimeStore | ControlRuntimeRepository, private readonly now: () => number = Date.now) {
    this.repository = store instanceof ControlRuntimeRepository ? store : new ControlRuntimeRepository(store);
  }

  initialize(): Promise<void> { return this.repository.initialize(); }
  snapshot(): ControlRuntimeSnapshot { return this.repository.snapshot(); }

  async queue(input: ControlCommandInput): Promise<ControlCommand> {
    if (!input.taskId || !input.harnessId || !input.idempotencyKey) throw new Error("Control commands require task, harness, and idempotency IDs");
    const existing = this.snapshot().commands.find((command) => command.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    const now = this.now();
    const command: ControlCommand = { ...structuredClone(input), id: `control:${randomUUID()}`, status: "queued", createdAt: now, updatedAt: now };
    await this.repository.mutate((value) => { value.commands.push(command); });
    return structuredClone(command);
  }

  async deliver(commandId: string, deliver: (command: ControlCommand) => Promise<HarnessControlResult>): Promise<ControlCommand> {
    const delivered = await this.update(commandId, { status: "delivered", detail: undefined });
    try {
      const result = await deliver(delivered);
      return this.update(commandId, result.accepted ? { status: "acknowledged", detail: result.reason } : { status: "rejected", detail: result.reason ?? "Harness rejected the control command" });
    } catch (error) {
      return this.update(commandId, { status: "rejected", detail: error instanceof Error ? error.message : "Control delivery failed" });
    }
  }

  private async update(commandId: string, patch: Pick<ControlCommand, "status"> & { detail?: string }): Promise<ControlCommand> {
    let output: ControlCommand | undefined;
    await this.repository.mutate((value) => {
      const command = value.commands.find((entry) => entry.id === commandId);
      if (!command) throw new Error("Control command was not found");
      command.status = patch.status;
      if (patch.detail) command.detail = patch.detail;
      else delete command.detail;
      command.updatedAt = this.now();
      output = structuredClone(command);
    });
    return output!;
  }
}
