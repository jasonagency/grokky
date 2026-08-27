import type { ControlRuntimeStore } from "../../src/main/control-plane/steering-service";

export class MemoryRuntimeStore implements ControlRuntimeStore {
  value: string | null = null;
  async readControlRuntime() { return this.value; }
  async writeControlRuntime(value: string) { this.value = value; }
}
