import { createHash, randomUUID } from "node:crypto";
import type {
  ControlPlaneEvent,
  EventAppendResult,
  NewControlPlaneEvent,
  ProjectionChange,
  StoredEventAppend,
} from "../../shared/control-plane-contracts";
import {
  CONTROL_PLANE_EVENT_SCHEMA_VERSION,
  MAX_EVENT_ARTIFACT_BYTES,
  MAX_INLINE_EVENT_PAYLOAD_BYTES,
  MAX_PROJECTION_CHANGE_BYTES,
} from "../../shared/control-plane-contracts";
import type { Conversation } from "../../shared/contracts";
import type { ControlPlaneDatabase } from "../storage/database-types";
import { EventBus, type ProjectionListener } from "./event-bus";
import { EventProjector } from "./event-projector";

function encodedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function validateEvent(event: ControlPlaneEvent): void {
  if (!event.id || event.id.length > 240) throw new Error("Control-plane event ID is invalid");
  if (!event.aggregateId || event.aggregateId.length > 240) throw new Error("Control-plane aggregate ID is invalid");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error("Control-plane sequence must be a positive integer");
  if (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0) throw new Error("Control-plane timestamp is invalid");
  if (!event.source || event.source.length > 120) throw new Error("Control-plane event source is invalid");
  if (event.schemaVersion !== CONTROL_PLANE_EVENT_SCHEMA_VERSION) throw new Error("Unsupported control-plane event schema");
}

function previewForPayload(payload: unknown): string {
  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
  const message = value?.message && typeof value.message === "object" ? value.message as Record<string, unknown> : undefined;
  const content = typeof message?.content === "string" ? message.content : JSON.stringify(payload);
  const preview = content.replace(/\s+/g, " ").trim().slice(0, 2_000);
  return preview ? `${preview}${content.length > preview.length ? "…" : ""}\n\n[Full content stored as a local trace artifact.]` : "[Content stored as a local trace artifact.]";
}

function boundEvent(event: ControlPlaneEvent): { event: ControlPlaneEvent; appendArtifact?: StoredEventAppend["artifact"] } {
  const content = JSON.stringify(event.payload);
  const byteSize = Buffer.byteLength(content, "utf8");
  if (byteSize <= MAX_INLINE_EVENT_PAYLOAD_BYTES) return { event };
  if (byteSize > MAX_EVENT_ARTIFACT_BYTES) throw new Error(`Control-plane event payload exceeds the ${MAX_EVENT_ARTIFACT_BYTES}-byte artifact limit`);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const retentionUntil = event.timestamp + 30 * 24 * 60 * 60 * 1_000;
  const reference = {
    sha256,
    byteSize,
    mediaType: "application/json" as const,
    storagePath: `sqlite://event-artifacts/${sha256}`,
    retentionUntil,
  };
  return {
    event: { ...event, payload: { artifact: reference, preview: previewForPayload(event.payload) } },
    appendArtifact: { reference, content },
  };
}

function artifactSha256(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const artifact = (payload as { artifact?: unknown }).artifact;
  if (!artifact || typeof artifact !== "object") return undefined;
  const sha256 = (artifact as { sha256?: unknown }).sha256;
  return typeof sha256 === "string" ? sha256 : undefined;
}

export class ControlPlaneService {
  private projector = new EventProjector();
  private readonly bus = new EventBus();
  private readonly sequences = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;

  constructor(private readonly database: ControlPlaneDatabase) {}

  async initialize(options: { rebuild?: boolean; conversations?: Conversation[] } = {}): Promise<void> {
    if (this.initialized && !options.rebuild) return;
    const events = (await this.database.listEvents())
      .map((value) => JSON.parse(value) as ControlPlaneEvent)
      .sort((left, right) => left.aggregateId.localeCompare(right.aggregateId) || left.sequence - right.sequence);
    this.projector = new EventProjector(options.rebuild ? [] : options.conversations ?? []);
    this.sequences.clear();
    for (const storedEvent of events) {
      let event = storedEvent;
      const sha256 = artifactSha256(storedEvent.payload);
      if (sha256) {
        const content = await this.database.readEventArtifact(sha256);
        if (!content) throw new Error(`Missing control-plane event artifact ${sha256}`);
        event = { ...storedEvent, payload: JSON.parse(content) as unknown };
      }
      validateEvent(event);
      this.projector.apply(event);
      this.sequences.set(event.aggregateId, Math.max(this.sequences.get(event.aggregateId) ?? 0, event.sequence));
    }
    this.initialized = true;
  }

  subscribe(listener: ProjectionListener): () => void {
    return this.bus.subscribe(listener);
  }

  conversationProjection(conversationId: string): Conversation | undefined {
    return this.projector.conversation(conversationId);
  }

  async nextSequence(aggregateId: string): Promise<number> {
    return (this.sequences.get(aggregateId) ?? 0) + 1;
  }

  append(event: ControlPlaneEvent): Promise<EventAppendResult> {
    return this.enqueue(() => this.appendInternal(event));
  }

  record(input: NewControlPlaneEvent): Promise<EventAppendResult> {
    return this.enqueue(() => this.appendInternal({
      ...input,
      id: input.id ?? randomUUID(),
      sequence: (this.sequences.get(input.aggregateId) ?? 0) + 1,
      timestamp: input.timestamp ?? Date.now(),
      schemaVersion: CONTROL_PLANE_EVENT_SCHEMA_VERSION,
    }));
  }

  private async appendInternal(input: ControlPlaneEvent): Promise<EventAppendResult> {
    if (!this.initialized) throw new Error("Control-plane service is not initialized");
    validateEvent(input);
    const { event, appendArtifact } = boundEvent(structuredClone(input));
    const candidate = this.projector.fork();
    const change = candidate.apply(input);
    if (encodedSize(change) > MAX_PROJECTION_CHANGE_BYTES) throw new Error("Projection change exceeds the renderer IPC limit");
    const projection = change.kind === "conversation" ? JSON.stringify(change.conversation) : undefined;
    const result = await this.database.appendEvent({ event: JSON.stringify(event), ...(projection ? { projection } : {}), ...(appendArtifact ? { artifact: appendArtifact } : {}) });
    if (result.status === "rejected") {
      this.bus.publish({
        eventId: event.id,
        aggregateId: event.aggregateId,
        sequence: event.sequence,
        kind: "diagnostic",
        diagnostic: result.diagnostic,
      });
      return result;
    }
    if (result.status === "duplicate") return result;
    this.projector = candidate;
    this.sequences.set(event.aggregateId, event.sequence);
    this.bus.publish(change);
    return result;
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
