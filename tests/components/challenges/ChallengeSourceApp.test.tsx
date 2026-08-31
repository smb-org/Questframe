import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChallengeSourceApp } from "../../../src/challenges/ChallengeSourceApp";
import { ChallengeLog } from "../../../src/modules/win-challenges/ui/ChallengeLog";
import { MAX_TOTAL_ROWS } from "../../../src/modules/win-challenges/contracts/predicates";
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

const fixedNow = Date.parse("2026-08-31T12:00:00.000Z");

const globalTimer = (state: "running" | "paused" | "expired"): NonNullable<ChallengeUpdate["settings"]["globalTimer"]> => ({
  totalMs: 60_000,
  endsAt: state === "paused" ? null : new Date(fixedNow + (state === "running" ? 30_000 : -1_000)).toISOString(),
  pausedRemainMs: state === "paused" ? 30_000 : null,
});

const sourceUpdate = (overrides: Partial<ChallengeUpdate> = {}): ChallengeUpdate => ({
  ...message(),
  ...overrides,
  settings: {
    ...message().settings,
    ...(overrides.settings ?? {}),
  },
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

  it("setzt den frei wählbaren Kopf und den Sessionstand", () => {
    const current = message();
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      settings: { ...current.settings, headerTitle: "ABENTEUER" },
      challenges: [
        challenge("done", "Fertig", "done", 0),
        challenge("open", "Offen", "pending", 1),
      ],
    })} />);

    expect(screen.getByText("ABENTEUER")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("setzt die Leerzustands-Matrix für keine Challenges und keinen Timer um", () => {
    const view = render(<ChallengeLog now={fixedNow} update={sourceUpdate({ challenges: [] })} />);
    expect(view.container.firstChild).toBeNull();
  });

  it.each(["running", "paused", "expired"] as const)(
    "zeigt bei keinen Challenges den globalen Timer im Zustand %s ohne Liste",
    (state) => {
      render(<ChallengeLog now={fixedNow} update={sourceUpdate({
        challenges: [],
        settings: { ...message().settings, globalTimer: globalTimer(state) },
      })} />);
      expect(screen.getByText("CHALLENGES")).toBeInTheDocument();
      expect(screen.getByLabelText(/Globaler Timer/)).toHaveAttribute("data-state", state);
      expect(document.querySelectorAll(".challenge-source__row")).toHaveLength(0);
    },
  );

  it("behandelt nur alte fertige Challenges ohne aktiven Timer als leer", () => {
    const old = { ...challenge("old", "Alte Challenge", "done", 0), completedAt: "2026-08-31T11:59:00.000Z" };
    const view = render(<ChallengeLog now={fixedNow} update={sourceUpdate({ challenges: [old] })} />);
    expect(view.container.firstChild).toBeNull();
  });

  it("zeigt Kopf und Timer für nur alte fertige Challenges mit aktivem Timer", () => {
    const old = { ...challenge("old", "Alte Challenge", "done", 0), completedAt: "2026-08-31T11:59:00.000Z" };
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      challenges: [old],
      settings: { ...message().settings, globalTimer: globalTimer("running") },
    })} />);
    expect(screen.getByText("CHALLENGES")).toBeInTheDocument();
    expect(screen.getByLabelText(/Globaler Timer/)).toBeInTheDocument();
    expect(screen.queryByText("Alte Challenge")).not.toBeInTheDocument();
  });

  it("zeigt bei mindestens einer offenen Challenge den vollständigen Zustand", () => {
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      challenges: [challenge("open", "Offene Challenge", "pending", 0)],
    })} />);
    expect(screen.getByText("Offene Challenge")).toBeInTheDocument();
    expect(screen.getByText("3 / 10")).toBeInTheDocument();
  });

  it("markiert kritische Restzeit auch ohne Farbe und pulsiert nicht bei reduziertem Motion-Wunsch", () => {
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      challenges: [challenge("open", "Offene Challenge", "pending", 0)],
      settings: { ...message().settings, globalTimer: globalTimer("running") },
    })} />);
    const timer = screen.getByLabelText(/Globaler Timer/);
    expect(timer).toHaveAttribute("data-critical", "true");
    expect(timer).toHaveTextContent("!");
    expect(timer).toHaveTextContent("kritisch");
  });

  it("zeigt den Überlauf und hält die sichtbare Auswahl unter dem harten Gesamtlimit", () => {
    const openChallenges = Array.from({ length: 10 }, (_, index) => challenge(`open-${String(index)}`, `Offen ${String(index)}`, "pending", index));
    const finishedChallenges = Array.from({ length: 30 }, (_, index) => ({
      ...challenge(`done-${String(index)}`, `Fertig ${String(index)}`, "done", index + 10),
      completedAt: new Date(fixedNow - 1_000).toISOString(),
    }));
    const update = sourceUpdate({
      challenges: [...openChallenges, ...finishedChallenges],
      settings: { ...message().settings, maxVisible: 10 },
    });
    render(<ChallengeLog now={fixedNow} update={update} />);
    expect(screen.getByText("+3 weitere")).toBeInTheDocument();
    expect(document.querySelectorAll(".challenge-source__row").length).toBeLessThanOrEqual(MAX_TOTAL_ROWS);
  });
});
