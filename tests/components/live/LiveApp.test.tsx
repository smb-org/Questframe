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
  targetCount: 10,
  timerTotalMs: 60_000,
  sortOrder: 0,
  hidden: false,
  currentCount,
  state: "pending",
  timerEndsAt: null,
  timerRemainMs: null,
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
    surfaceOpacity: 100,
    headerStyle: "default",
    fontFamily: "theme",
    fontScale: 1,
    headerTitle: "CHALLENGES",
    penaltyLabel: "STRAFE",
    penaltyText: "",
    effectsEnabled: true,
    maxVisible: 5,
    overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end",
    globalTimerMode: "down",
    themeId: "trail-wood",
    globalTimer: null,
    placement: { x: 300, y: 8, scale: 1 },
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
  it("zeigt im Hochzählmodus die verstrichene Zeit, das Hochzähl-Präfix und keinen kritischen Zustand", () => {
    render(<LiveApp />);
    emitUpdate({
      ...message(),
      settings: {
        ...message().settings,
        globalTimerMode: "up",
        globalTimer: {
          totalMs: 60_000,
          endsAt: new Date(Date.now() + 30_000).toISOString(),
          pausedRemainMs: null,
        },
      },
    });

    const timer = document.querySelector(".live-page__global-display");
    expect(timer).toHaveTextContent("▴");
    expect(timer).toHaveTextContent("0:30");
    expect(timer).toHaveAttribute("data-critical", "false");
  });

  it("zeigt im Hochzählmodus nach Erreichen der Kappe weder Ablauf-Label noch Ablauftext", () => {
    render(<LiveApp />);
    emitUpdate({
      ...message(),
      settings: {
        ...message().settings,
        globalTimerMode: "up",
        globalTimer: {
          totalMs: 86_400_000,
          endsAt: new Date(Date.now() - 1_000).toISOString(),
          pausedRemainMs: null,
        },
      },
    });

    const timer = document.querySelector(".live-page__global-display");
    expect(timer).toHaveTextContent("24:00:00");
    expect(timer).toHaveAttribute("data-state", "expired");
    expect(timer).toHaveAttribute("data-critical", "false");
    expect(timer).not.toHaveTextContent("abgelaufen");
    expect(timer).toHaveAttribute("aria-label", "Globaler Timer: 24:00:00, hochzählend");
  });

  it("zeigt im Hochzählmodus vor dem Start und nach dem Reset null", () => {
    render(<LiveApp />);
    emitUpdate({
      ...message(),
      settings: {
        ...message().settings,
        globalTimerMode: "up",
        globalTimer: { totalMs: 60_000, endsAt: null, pausedRemainMs: null },
      },
    });

    const timer = document.querySelector(".live-page__global-display");
    expect(timer).toHaveTextContent("▴");
    expect(timer).toHaveTextContent("0:00");
    expect(timer).toHaveAttribute("data-state", "idle");
    expect(timer).toHaveAttribute("aria-label", "Globaler Timer: 0:00, hochzählend");
  });

  it("verwendet den Dock-Token und den Dock-Socket", () => {
    render(<LiveApp />);
    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toMatch(/\/ws\/dock$/);
    expect(socket?.protocols).toEqual([DOCK_SOCKET_PROTOCOL, token]);
  });

  it("zeigt versteckte Challenges mit Badge und zählt sie separat", () => {
    const hidden = { ...challenge(), id: "hidden", title: "Bonus", hidden: true };
    const done = { ...challenge(), id: "done", title: "Erledigt", state: "done" as const, currentCount: 10, hidden: false };
    const visible = { ...challenge(), id: "visible", title: "Sichtbar", hidden: false };
    render(<LiveApp />);
    emitUpdate({
      ...message(),
      challenges: [done, visible, hidden],
    });

    expect(screen.getByLabelText("Challenge-Stand")).toHaveTextContent("1 / 2(+1)");
    expect(screen.getByText("Bonus")).toBeInTheDocument();
    expect(screen.getByText("ausgeblendet")).toBeInTheDocument();
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

  it("wendet optimistisches Abhaken vor Stand und Auswahl an", async () => {
    const user = userEvent.setup();
    const challenges = [0, 1, 2, 3].map((sortOrder) => ({
      ...challenge(),
      id: `challenge-${String(sortOrder)}`,
      title: `Challenge ${String(sortOrder)}`,
      sortOrder,
    }));
    render(<LiveApp />);
    emitUpdate({
      ...message(),
      settings: { ...message().settings },
      challenges,
    });

    await user.click(screen.getByRole("button", { name: "Challenge 0 abhaken" }));

    expect(screen.getByLabelText("Challenge-Stand")).toHaveTextContent("1 / 4");
    expect(screen.getByText("Challenge 3")).toBeInTheDocument();
    expect(document.querySelector("[data-challenge-id='challenge-0']"))
      .toHaveAttribute("data-state", "done");
  });

  it("zeigt beim optimistischen Rückgängigmachen die vollständige Liste", async () => {
    const user = userEvent.setup();
    const done = { ...challenge(), id: "done", title: "Erledigt", state: "done" as const, currentCount: 10, sortOrder: 0 };
    const open = [1, 2, 3].map((sortOrder) => ({
      ...challenge(),
      id: `open-${String(sortOrder)}`,
      title: `Offen ${String(sortOrder)}`,
      sortOrder,
    }));
    render(<LiveApp />);
    emitUpdate({
      ...message(),
      settings: { ...message().settings },
      challenges: [done, ...open],
    });

    await user.click(screen.getByRole("button", { name: "Erledigt Rückgängig" }));

    const rows = [...document.querySelectorAll(".live-page__challenge-row")];
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.getAttribute("data-state") !== "done")).toBe(true);
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
    await user.click(screen.getByRole("button", { name: "Offene Challenge starten" }));
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

  it("zeigt bei einem laufenden Challenge-Timer die Restzeit und wird unter 60 Sekunden kritisch", () => {
    vi.useFakeTimers();
    try {
      render(<LiveApp />);
      emitUpdate({
        ...message(),
        challenges: [{ ...challenge(), state: "active", timerEndsAt: new Date(Date.now() + 45_000).toISOString() }],
      });

      const time = document.querySelector(".live-page__challenge-time");
      expect(time).toHaveTextContent("0:45");
      expect(time).toHaveAttribute("data-state", "running");
      expect(time).toHaveAttribute("data-critical", "true");
      expect(time).toHaveAttribute("aria-label", "Restzeit 0:45");
      expect(screen.getByRole("button", { name: "Offene Challenge pausieren" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("zeigt bei einem abgelaufenen Challenge-Timer den Ablauftext", () => {
    vi.useFakeTimers();
    try {
      render(<LiveApp />);
      emitUpdate({
        ...message(),
        challenges: [{ ...challenge(), state: "active", timerEndsAt: new Date(Date.now() - 1_000).toISOString() }],
      });

      const time = document.querySelector(".live-page__challenge-time");
      expect(time).toHaveTextContent("abgelaufen");
      expect(time).toHaveAttribute("data-state", "expired");
      expect(time).toHaveAttribute("data-critical", "true");
      expect(time).toHaveAttribute("aria-label", "Timer abgelaufen");
    } finally {
      vi.useRealTimers();
    }
  });

  it("zeigt pausierte Restzeit und eingefrorene Restzeit bei erledigten Challenges", () => {
    render(<LiveApp />);
    emitUpdate({
      ...message(),
      challenges: [{ ...challenge(), state: "pending", timerRemainMs: 192_000 }],
    });

    const pausedTime = document.querySelector(".live-page__challenge-time");
    expect(pausedTime).toHaveTextContent("Ⅱ 3:12");
    expect(pausedTime).toHaveAttribute("data-state", "paused");
    expect(screen.getByRole("button", { name: "Offene Challenge starten" })).toBeInTheDocument();

    emitUpdate({
      ...message(),
      challenges: [{
        ...challenge(),
        state: "done",
        timerRemainMs: 0,
        completedAt: now,
      }],
    });

    const doneTime = document.querySelector(".live-page__challenge-time");
    expect(doneTime).toHaveTextContent("0:00");
    expect(doneTime).toHaveAttribute("data-state", "done");
    expect(doneTime).toHaveAttribute("aria-label", "Rest bei Abschluss 0:00");
    expect(screen.queryByRole("button", { name: "Offene Challenge starten" })).not.toBeInTheDocument();
  });

  it("setzt einen Challenge-Timer per Icon zurück und deaktiviert Reset im Idle-Zustand", async () => {
    const user = userEvent.setup();
    render(<LiveApp />);
    emitUpdate();

    const idleReset = screen.getByRole("button", { name: "Offene Challenge zurücksetzen" });
    expect(idleReset).toBeDisabled();

    emitUpdate({
      ...message(),
      challenges: [{ ...challenge(), state: "active", timerEndsAt: new Date(Date.now() + 30_000).toISOString() }],
    });
    const reset = screen.getByRole("button", { name: "Offene Challenge zurücksetzen" });
    expect(reset).toBeEnabled();
    await user.click(reset);

    const requestInit = vi.mocked(fetch).mock.calls.at(-1)?.[1];
    expect(requestInit?.body).toEqual(expect.stringContaining('"type":"resetTimer"'));
    expect(requestInit?.body).toEqual(expect.stringContaining('"challengeId":"challenge-1"'));
  });

  it("bietet keinen Reset des globalen Timers an", () => {
    render(<LiveApp />);
    emitUpdate();
    expect(screen.queryByRole("button", { name: "Globaler Timer zurücksetzen" })).not.toBeInTheDocument();
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
