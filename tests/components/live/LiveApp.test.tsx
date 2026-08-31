import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveApp } from "../../../src/live/LiveApp";
import type { ChallengeUpdate } from "../../../src/shared/contracts/win-challenges";
import { DOCK_SOCKET_PROTOCOL } from "../../../src/shared/contracts/protocol";

const token = "D".repeat(43);
const now = "2026-08-31T12:00:00.000Z";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly protocols: string[];
  private readonly listeners = new Map<string, Array<(event: Event & { data?: unknown }) => void>>();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, callback: (event: Event & { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data?: unknown): void {
    for (const callback of this.listeners.get(type) ?? []) callback({ type, data } as Event & { data?: unknown });
  }

  close(): void {}
}

const challenge = (currentCount = 3): ChallengeUpdate["challenges"][number] => ({
  id: "challenge-1",
  title: "Offene Challenge",
  description: null,
  targetCount: 10,
  timerTotalMs: 60_000,
  sortOrder: 0,
  currentCount,
  state: "pending",
  timerEndsAt: null,
  completedAt: null,
  createdAt: now,
  updatedAt: now,
});

const message = (currentCount = 3): ChallengeUpdate => ({
  eventSeq: currentCount === 3 ? 0 : 1,
  boardRevision: 1,
  settingsRevision: 1,
  settings: {
    styleId: "plain-list",
    themeMode: "inherit",
    surfaceMode: "surface",
    headerTitle: "CHALLENGES",
    effectsEnabled: true,
    maxVisible: 5,
    themeId: "trail-wood",
    globalTimer: null,
  },
  challenges: [challenge(currentCount)],
  event: null,
});

const emitUpdate = (value = message()): void => {
  const socket = FakeWebSocket.instances[0];
  act(() => socket?.emit("message", JSON.stringify(value)));
};

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  window.history.replaceState({}, "", `/live/challenges#token=${token}`);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024, writable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Live-Bedienseite", () => {
  it("verwendet den Dock-Token und den Dock-Socket", () => {
    render(<LiveApp />);
    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toMatch(/\/ws\/dock$/);
    expect(socket?.protocols).toEqual([DOCK_SOCKET_PROTOCOL, token]);
  });

  it("springt beim Zählen optimistisch und übernimmt danach challenge_update als Wahrheit", async () => {
    const user = userEvent.setup();
    render(<LiveApp />);
    emitUpdate();
    const plus = screen.getByRole("button", { name: "Offene Challenge um 1 erhöhen" });
    await user.click(plus);
    expect(screen.getByText("4 / 10")).toBeInTheDocument();
    expect(document.querySelector("[data-challenge-id='challenge-1']"))
      .toHaveClass("live-page__challenge-row--pending");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/challenges/commands",
      expect.anything(),
    );
    const requestInit = vi.mocked(fetch).mock.calls.at(-1)?.[1];
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toEqual(expect.objectContaining({ authorization: `Bearer ${token}` }));

    emitUpdate(message(3));
    expect(screen.getByText("3 / 10")).toBeInTheDocument();
    expect(document.querySelector("[data-challenge-id='challenge-1']"))
      .not.toHaveClass("live-page__challenge-row--pending");
  });

  it("rollt bei einem konkreten Fehler zurück und zeigt ihn kurz in der Zeile", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "challenge_timer_not_configured",
        message: "Für diese Challenge ist kein Timer eingerichtet.",
      },
    }), { status: 422, headers: { "content-type": "application/json" } }));
    render(<LiveApp />);
    emitUpdate();
    await user.click(screen.getByRole("button", { name: "Offene Challenge Timer starten" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Für diese Challenge ist kein Timer eingerichtet."));
    expect(screen.getByText("3 / 10")).toBeInTheDocument();
  });

  it("meldet bei not_found die gelöschte Challenge, bevor die Zeile verschwindet", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      error: { code: "not_found", message: "Challenge nicht gefunden." },
    }), { status: 404, headers: { "content-type": "application/json" } }));
    render(<LiveApp />);
    emitUpdate();
    await user.click(screen.getByRole("button", { name: "Offene Challenge um 1 erhöhen" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Challenge wurde gerade gelöscht."));
    expect(screen.getByText("3 / 10")).toBeInTheDocument();
  });

  it("bietet keinen Reset des globalen Timers an", () => {
    render(<LiveApp />);
    emitUpdate();
    expect(screen.queryByRole("button", { name: /reset|zurücksetzen/i })).not.toBeInTheDocument();
  });

  it("lässt unter 280 Pixeln nur die gepinnte Challenge mit Zähler im DOM", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 240, writable: true });
    render(<LiveApp />);
    emitUpdate();
    expect(screen.getByText("Offene Challenge")).toBeInTheDocument();
    expect(screen.getByText("3 / 10")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Offene Challenge/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Live-Steuerung" })).not.toBeInTheDocument();
  });
});
