import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChallengeSourceApp } from "../../../src/challenges/ChallengeSourceApp";
import type { ChallengeUpdate } from "../../../src/shared/contracts/win-challenges";
import { OVERLAY_SOCKET_PROTOCOL } from "../../../src/shared/contracts/protocol";

const token = "A".repeat(43);

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

const challenge = (id: string, title: string, state: "pending" | "done", sortOrder: number): ChallengeUpdate["challenges"][number] => ({
  id,
  title,
  description: null,
  targetCount: state === "done" ? 1 : 10,
  timerTotalMs: null,
  sortOrder,
  currentCount: state === "done" ? 1 : 3,
  state,
  timerEndsAt: null,
  completedAt: state === "done" ? new Date().toISOString() : null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const message = (): ChallengeUpdate => ({
  eventSeq: 0,
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
  challenges: [
    challenge("done", "Erledigt unten", "done", 0),
    challenge("open", "Offene Challenge", "pending", 1),
  ],
  event: null,
});

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  window.history.replaceState({}, "", `/overlay/challenges#token=${token}`);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ChallengeSourceApp", () => {
  it("rendert plain-list erst nach einer gültigen Nachricht und ordnet erledigte unten ein", () => {
    render(<ChallengeSourceApp />);
    expect(document.body).not.toHaveTextContent("Offene Challenge");
    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toMatch(/\/ws\/challenge$/);
    expect(socket?.protocols).toEqual([OVERLAY_SOCKET_PROTOCOL, token]);

    act(() => socket?.emit("message", JSON.stringify(message())));
    expect(screen.getByText("CHALLENGES")).toBeInTheDocument();
    expect(screen.getByText("3 / 10")).toBeInTheDocument();
    const rows = [...document.querySelectorAll(".challenge-source__row")];
    expect(rows.map((row) => row.textContent)).toEqual(["▸Offene Challenge3 / 10", "✓Erledigt unten1 / 1"]);
  });

  it("blendet das Log bei Parse-Fehlern aus und zeigt es bei der nächsten gültigen Nachricht wieder", () => {
    render(<ChallengeSourceApp />);
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.emit("message", JSON.stringify(message())));
    expect(screen.getByText("Offene Challenge")).toBeInTheDocument();
    act(() => socket?.emit("message", JSON.stringify({ ...message(), settings: { ...message().settings, maxVisible: 11 } })));
    expect(document.body).not.toHaveTextContent("Offene Challenge");
    act(() => socket?.emit("message", JSON.stringify(message())));
    expect(screen.getByText("Offene Challenge")).toBeInTheDocument();
  });

  it("blendet das Log bei einem Verbindungsabbruch aus", () => {
    vi.useFakeTimers();
    render(<ChallengeSourceApp />);
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.emit("message", JSON.stringify(message())));
    act(() => socket?.emit("close"));
    expect(document.body).not.toHaveTextContent("Offene Challenge");
  });
});
