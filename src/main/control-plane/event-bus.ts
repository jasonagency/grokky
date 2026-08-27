import type { ProjectionChange } from "../../shared/control-plane-contracts";

export type ProjectionListener = (change: ProjectionChange) => void;

export class EventBus {
  private readonly listeners = new Set<ProjectionListener>();

  subscribe(listener: ProjectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(change: ProjectionChange): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(change));
      } catch {
        // A renderer subscriber cannot prevent durable event processing.
      }
    }
  }
}
