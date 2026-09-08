import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SOCKET_PING_INTERVAL_MS,
  startSocketHeartbeat,
} from "../../../src/shared/reconnect";

describe("Socket-Heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sendet im Intervall Ping-Nachrichten auf einem offenen Socket", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const socket = {
      readyState: WebSocket.OPEN,
      send,
    } as unknown as WebSocket;

    const stop = startSocketHeartbeat(socket, SOCKET_PING_INTERVAL_MS);

    // Kein Ping beim Start: der würde das Durable Object treffen, bevor es die
    // Verbindung fertig eingerichtet hat.
    vi.advanceTimersByTime(SOCKET_PING_INTERVAL_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledWith("ping");
    vi.advanceTimersByTime(SOCKET_PING_INTERVAL_MS * 2);
    expect(send).toHaveBeenCalledTimes(3);

    stop();
  });

  it("pingt sofort, wenn der Tab wieder sichtbar wird", () => {
    // Hintergrund-Tabs drosseln setInterval auf etwa einen Aufruf pro Minute. Ein
    // zurückgeholter Tab darf nicht erst das nächste Intervall abwarten, sonst
    // räumt das Durable Object ihn als verwaist ab.
    vi.useFakeTimers();
    const send = vi.fn();
    const socket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;

    const stop = startSocketHeartbeat(socket, SOCKET_PING_INTERVAL_MS);
    expect(send).not.toHaveBeenCalled();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(send).toHaveBeenCalledTimes(1);

    stop();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sendet nicht auf einem nicht offenen Socket", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const socket = {
      readyState: WebSocket.CLOSED,
      send,
    } as unknown as WebSocket;

    const stop = startSocketHeartbeat(socket, 1_000);

    vi.advanceTimersByTime(5_000);

    expect(send).not.toHaveBeenCalled();
    stop();
  });

  it("stoppt nach dem Aufräumen und überlebt einen Sendefehler", () => {
    vi.useFakeTimers();
    const send = vi.fn()
      .mockImplementationOnce(() => { throw new Error("Socket geschlossen"); })
      .mockImplementation(() => undefined);
    const socket = {
      readyState: WebSocket.OPEN,
      send,
    } as unknown as WebSocket;

    const stop = startSocketHeartbeat(socket, 1_000);

    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(send).toHaveBeenCalledTimes(2);

    stop();
    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
