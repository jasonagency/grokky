import type { CodexAppServerTransport } from "./codex-app-server-process";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PROTOCOL_MESSAGE_BYTES = 2 * 1024 * 1024;

export interface AppServerMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export type AppServerNotificationListener = (method: string, params: unknown) => void | Promise<void>;
export type AppServerRequestListener = (method: string, params: unknown) => unknown | Promise<unknown>;

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function protocolError(message: string, cause?: unknown): Error {
  return new Error(`Codex App Server protocol error: ${message}`, cause === undefined ? undefined : { cause });
}

function validateMessage(value: unknown): AppServerMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw protocolError("message must be an object");
  const message = value as AppServerMessage;
  const hasMethod = typeof message.method === "string" && message.method.length > 0;
  const hasId = typeof message.id === "string" || typeof message.id === "number";
  if (!hasMethod && !hasId) throw protocolError("message has neither method nor request id");
  if (hasMethod && message.method!.length > 200) throw protocolError("method is too long");
  return message;
}

export class CodexAppServerClient {
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly notificationListeners = new Set<AppServerNotificationListener>();
  private readonly fatalListeners = new Set<(error: Error) => void>();
  private requestListener?: AppServerRequestListener;
  private nextId = 1;
  private fatalError?: Error;
  private readonly unsubscribeLine: () => void;
  private readonly unsubscribeExit: () => void;

  constructor(private readonly transport: CodexAppServerTransport) {
    this.unsubscribeLine = transport.onLine((line) => this.receiveLine(line));
    this.unsubscribeExit = transport.onExit((error) => this.fail(error));
  }

  async initialize(): Promise<void> {
    const result = await this.request("initialize", {
      clientInfo: { name: "grokky", title: "Grokky", version: "0.1.2" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (!result || typeof result !== "object" || typeof (result as Record<string, unknown>).userAgent !== "string") {
      throw protocolError("unsupported initialize response");
    }
    this.notify("initialized");
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(protocolError(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.transport.write(JSON.stringify({ method, id, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(protocolError(`failed to send ${method}`, error));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.fatalError) throw this.fatalError;
    this.transport.write(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  onNotification(listener: AppServerNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(listener: AppServerRequestListener): void {
    this.requestListener = listener;
  }

  onFatal(listener: (error: Error) => void): () => void {
    this.fatalListeners.add(listener);
    if (this.fatalError) listener(this.fatalError);
    return () => this.fatalListeners.delete(listener);
  }

  private receiveLine(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_MESSAGE_BYTES) {
      this.fail(protocolError("message exceeds size limit"));
      return;
    }
    let message: AppServerMessage;
    try {
      message = validateMessage(JSON.parse(line));
    } catch (error) {
      this.fail(error instanceof Error && error.message.startsWith("Codex App Server protocol error:") ? error : protocolError("malformed JSON", error));
      return;
    }
    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(protocolError(`${pending.method} failed: ${message.error.message || "unknown error"}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const listener of this.notificationListeners) void Promise.resolve(listener(message.method, message.params)).catch((error) => this.fail(error instanceof Error ? error : protocolError("notification handler failed", error)));
    }
  }

  private async handleServerRequest(message: AppServerMessage): Promise<void> {
    try {
      if (!this.requestListener) throw protocolError(`unsupported server request ${message.method}`);
      const result = await this.requestListener(message.method!, message.params);
      this.transport.write(JSON.stringify({ id: message.id, result }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "request handler failed";
      this.transport.write(JSON.stringify({ id: message.id, error: { code: -32601, message: detail } }));
    }
  }

  private fail(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    this.fatalListeners.forEach((listener) => listener(error));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  get error(): Error | undefined {
    return this.fatalError;
  }

  async close(): Promise<void> {
    this.unsubscribeLine();
    this.unsubscribeExit();
    this.fail(new Error("Codex App Server client closed"));
    this.fatalListeners.clear();
    await this.transport.close();
  }
}
