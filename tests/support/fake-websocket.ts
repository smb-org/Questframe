import { act } from "@testing-library/react";
import { vi } from "vitest";

type WebSocketEvent = Event & { data?: unknown };

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static opensOnCreate = false;
  static tracksClose = false;
  static readyStateOnCreate: number | undefined;
  static sendMode: "record" | "noop" | undefined;

  readonly url: string;
  readonly protocols: string[];
  readonly sentMessages: string[] = [];
  closed = false;
  declare readonly readyState?: number;
  declare readonly send?: (data: string) => void;
  private readonly listeners = new Map<string, Array<(event: WebSocketEvent) => void>>();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.readyStateOnCreate !== undefined) this.readyState = FakeWebSocket.readyStateOnCreate;
    if (FakeWebSocket.sendMode === "record") this.send = (data) => { this.sentMessages.push(data); };
    if (FakeWebSocket.sendMode === "noop") this.send = () => undefined;
    if (FakeWebSocket.opensOnCreate) queueMicrotask(() => { this.emit("open"); });
  }

  addEventListener(type: string, callback: (event: WebSocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data?: unknown): void {
    for (const callback of this.listeners.get(type) ?? []) callback({ type, data } as WebSocketEvent);
  }

  close(): void {
    if (FakeWebSocket.tracksClose) this.closed = true;
  }

}

export const stubFakeWebSocket = (options: {
  opensOnCreate?: boolean;
  tracksClose?: boolean;
  readyState?: number;
  sendMode?: "record" | "noop";
} = {}): void => {
  FakeWebSocket.instances = [];
  FakeWebSocket.opensOnCreate = options.opensOnCreate ?? false;
  FakeWebSocket.tracksClose = options.tracksClose ?? false;
  FakeWebSocket.readyStateOnCreate = options.readyState;
  FakeWebSocket.sendMode = options.sendMode;
  vi.stubGlobal("WebSocket", FakeWebSocket);
};

export const deliverWebSocketMessage = async (socket: FakeWebSocket | undefined, input: unknown): Promise<void> => {
  await act(async () => {
    socket?.emit("message", JSON.stringify(input));
    await Promise.resolve();
  });
};

export const deliverRequiredWebSocketMessage = async (socket: FakeWebSocket | undefined, input: unknown): Promise<void> => {
  await act(async () => {
    if (socket === undefined) throw new TypeError("Cannot read properties of undefined (reading 'emit')");
    socket.emit("message", JSON.stringify(input));
    await Promise.resolve();
  });
};

export const setLocationToken = (path: string, token: string): void => {
  window.history.replaceState({}, "", `${path}#token=${token}`);
};
