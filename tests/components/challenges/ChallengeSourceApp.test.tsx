import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChallengeSourceApp } from "../../../src/challenges/ChallengeSourceApp";
import { ChallengeLog } from "../../../src/modules/win-challenges/ui/ChallengeLog";
import type { ChallengeStyleId, ChallengeThemeId, ChallengeUpdate } from "../../../src/shared/contracts/win-challenges";
import { OVERLAY_SOCKET_PROTOCOL } from "../../../src/shared/contracts/protocol";

const token = "A".repeat(43);

const messageType = (value: string): unknown => {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return "type" in parsed ? parsed.type : null;
};

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly protocols: string[];
  readonly sentMessages: string[] = [];
  readonly readyState = 1;
  private readonly listeners = new Map<string, Array<(event: Event & { data?: unknown }) => void>>();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
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

  send(data: string): void {
    this.sentMessages.push(data);
  }
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  readonly src: string;
  preload = "";
  currentTime = 0;
  readonly play = vi.fn(() => Promise.resolve());
  readonly load = vi.fn();

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
}

const challenge = (id: string, title: string, state: "pending" | "done", sortOrder: number): ChallengeUpdate["challenges"][number] => ({
  id,
  title,
  kind: "counter",
  unit: null,
  controlKey: "K7RP",
  targetCount: state === "done" ? 1 : 10,
  timerTotalMs: null,
  sortOrder,
  step: 1,
  bestCount: state === "done" ? 1 : 0,
  hidden: false,
  currentCount: state === "done" ? 1 : 3,
  state,
  timerEndsAt: null,
  timerRemainMs: null,
  completedAt: state === "done" ? new Date().toISOString() : null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const timedChallenge = (
  id: string,
  overrides: Partial<ChallengeUpdate["challenges"][number]> = {},
): ChallengeUpdate["challenges"][number] => ({
  ...challenge(id, id, "pending", 0),
  targetCount: null,
  timerTotalMs: 120_000,
  ...overrides,
});

const message = (): ChallengeUpdate => ({
  eventSeq: 0,
  boardRevision: 1,
  settingsRevision: 1,
  settings: {
    styleId: "plain-list",
    themeMode: "inherit",
    surfaceOpacity: 100,
    headerStyle: "default",
    textEmphasis: "auto",
    fontFamily: "theme",
    fontScale: 1,
    headerTitle: "CHALLENGES",
    penaltyLabel: "STRAFE",
    penaltyText: "",
    effectsEnabled: true,
    maxVisible: 5,
    overflowMode: "cut", overflowTempo: "medium", numbered: false, keyVisible: false, doneOrder: "end",
    globalTimerMode: "down",
    themeId: "trail-wood",
    globalTimer: null,
    placement: { x: 300, y: 8, scale: 1 },
  },
  challenges: [
    challenge("done", "Erledigt unten", "done", 0),
    challenge("open", "Offene Challenge", "pending", 1),
  ],
  event: null,
});

const fixedNow = Date.parse("2026-08-31T12:00:00.000Z");
const styleNames = ["plain-list", "plain-bullets", "quest-log"] as const;

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

const deliver = async (socket: FakeWebSocket | undefined, update: ChallengeUpdate): Promise<void> => {
  await act(async () => {
    socket?.emit("message", JSON.stringify(update));
    await Promise.resolve();
  });
};

const deferred = (): { promise: Promise<void>; resolve: () => void; reject: (reason?: Error) => void } => {
  let resolvePromise: () => void = () => undefined;
  let rejectPromise: (reason?: Error) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = (reason = new Error("Theme-Chunk fehlgeschlagen")) => reject(reason);
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeAudio.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  window.sessionStorage.clear();
  window.history.replaceState({}, "", `/overlay/challenges#token=${token}`);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ChallengeSourceApp", () => {
  it("lässt die Anzeige ohne time_sync-Antwort weiterlaufen", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    render(<ChallengeSourceApp loadStyle={() => Promise.resolve()} loadTheme={() => Promise.resolve()} />);
    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      await Promise.resolve();
    });
    await deliver(socket, sourceUpdate({
      challenges: [{
        ...timedChallenge("running", { state: "active", timerEndsAt: new Date(fixedNow + 5_000).toISOString() }),
        title: "Läuft weiter",
      }],
    }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Restzeit 0:05")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByLabelText("Restzeit 0:04")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("rechnet absolute Timer mit dem gemessenen Uhr-Offset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    render(<ChallengeSourceApp loadStyle={() => Promise.resolve()} loadTheme={() => Promise.resolve()} />);
    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      await Promise.resolve();
    });
    await deliver(socket, sourceUpdate({
      challenges: [{
        ...timedChallenge("running", { state: "active", timerEndsAt: new Date(fixedNow + 5_000).toISOString() }),
        title: "Korrigierte Uhr",
      }],
    }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Restzeit 0:05")).toBeInTheDocument();

    act(() => socket?.emit("message", JSON.stringify({
      type: "time_sync",
      clientTimestamp: fixedNow,
      serverTime: new Date(fixedNow + 1_000).toISOString(),
    })));

    expect(screen.getByLabelText("Restzeit 0:04")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("fordert beim Verbinden und nach einem Reconnect eine neue Zeitmessung an", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    render(<ChallengeSourceApp />);
    await act(async () => {
      await Promise.resolve();
    });
    const firstSocket = FakeWebSocket.instances[0];
    expect(firstSocket?.sentMessages).toHaveLength(3);
    expect(firstSocket?.sentMessages.map(messageType)).toEqual([
      "time_sync_request",
      "time_sync_request",
      "time_sync_request",
    ]);

    act(() => { firstSocket?.emit("close"); });
    act(() => { vi.advanceTimersByTime(750); });
    await act(async () => {
      await Promise.resolve();
    });

    const secondSocket = FakeWebSocket.instances[1];
    expect(secondSocket?.sentMessages).toHaveLength(3);
    expect(secondSocket?.sentMessages.map(messageType)).toEqual([
      "time_sync_request",
      "time_sync_request",
      "time_sync_request",
    ]);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("frischt die Zeitmessung nach fünf Minuten auf", async () => {
    vi.useFakeTimers();
    render(<ChallengeSourceApp />);
    await act(async () => {
      await Promise.resolve();
    });
    const socket = FakeWebSocket.instances[0];
    expect(socket?.sentMessages).toHaveLength(3);

    act(() => { vi.advanceTimersByTime(5 * 60 * 1_000); });

    expect(socket?.sentMessages).toHaveLength(6);
    vi.useRealTimers();
  });

  it("rendert plain-list erst nach einer gültigen Nachricht und ordnet erledigte unten ein", async () => {
    render(<ChallengeSourceApp />);
    expect(document.body).not.toHaveTextContent("Offene Challenge");
    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toMatch(/\/ws\/challenge$/);
    expect(socket?.protocols).toEqual([OVERLAY_SOCKET_PROTOCOL, token]);

    await deliver(socket, message());
    await waitFor(() => expect(screen.getByText("CHALLENGES")).toBeInTheDocument());
    expect(screen.getByText("CHALLENGES")).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "Challenge-Quelle" })).toHaveStyle({
      "--wc-x": "1500px",
      "--wc-y": "40px",
      "--wc-scale": "1",
    });
    expect(screen.getByText("3 / 10")).toBeInTheDocument();
    const rows = [...document.querySelectorAll(".challenge-source__row")];
    expect(rows.map((row) => row.textContent)).toEqual(["Offene Challenge3 / 10", "✓Erledigt unten1 / 1"]);
  });

  it("zeigt ohne Ziel die blanke Zahl, ab dem ersten Schritt", async () => {
    // Ohne Zaehler waeren die Plus-/Minus-Knoepfe unsichtbar: es zaehlt hoch, es
    // klingt, zu sehen ist nichts. Bei 0 bleibt die Zeile aber bewusst leer.
    render(<ChallengeSourceApp />);
    const socket = FakeWebSocket.instances[0];
    await deliver(socket, sourceUpdate({
      challenges: [
        { ...timedChallenge("gezaehlt"), title: "Ohne Ziel", currentCount: 4 },
        { ...timedChallenge("frisch"), title: "Noch nichts", currentCount: 0 },
      ],
    }));

    await waitFor(() => expect(screen.getByText("Ohne Ziel")).toBeInTheDocument());
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.queryByText("4 / null")).not.toBeInTheDocument();
    const rows = [...document.querySelectorAll(".challenge-source__row")];
    expect(rows.map((row) => row.textContent)).toEqual(["Ohne Ziel4", "Noch nichts"]);
  });

  it("zeigt den Bestwert nur bei streak und erst nach dem ersten Erfolg", () => {
    const streakBeforeFirstSuccess = {
      ...challenge("streak-before", "Streak vor Erfolg", "pending", 0),
      kind: "streak" as const,
      targetCount: 5,
      currentCount: 0,
      bestCount: 0,
    };
    const streakAfterFall = {
      ...streakBeforeFirstSuccess,
      id: "streak-after",
      title: "Streak nach Fall",
      bestCount: 4,
    };
    const counter = {
      ...streakAfterFall,
      id: "counter-best",
      title: "Counter ohne Bestspur",
      kind: "counter" as const,
      bestCount: 4,
    };
    const measure = {
      ...streakAfterFall,
      id: "measure-best",
      title: "Messwert ohne Bestspur",
      kind: "measure" as const,
      unit: "m",
      targetCount: 1_500,
      currentCount: 1_800,
      bestCount: 1_800,
    };

    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      challenges: [streakBeforeFirstSuccess, streakAfterFall, counter, measure],
      settings: { ...message().settings, maxVisible: 4 },
    })} />);

    const count = (id: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(`[data-challenge-id="${id}"] .challenge-source__count`);
      if (element === null) throw new Error(`Zähler für ${id} fehlt.`);
      return element;
    };
    expect(count("streak-before")).toHaveTextContent("0 / 5");
    expect(count("streak-before")).not.toHaveTextContent("Best");
    expect(count("streak-after")).toHaveTextContent("0 / 5 · Best 4");
    expect(count("counter-best")).not.toHaveTextContent("Best");
    expect(count("measure-best")).not.toHaveTextContent("Best");
  });

  it("unterscheidet eine noch nicht gestartete Messung von einer laufenden Messung bei null", () => {
    const measure = (id: string, title: string, state: "pending" | "active") => ({
      ...timedChallenge(id, {
        title,
        kind: "measure" as const,
        unit: "m",
        targetCount: 1_500,
        currentCount: 0,
        bestCount: 0,
        state,
        timerEndsAt: state === "active" ? new Date(fixedNow + 60_000).toISOString() : null,
      }),
    });

    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      challenges: [
        measure("measure-ready", "Messung bereit", "pending"),
        measure("measure-running", "Messung läuft", "active"),
      ],
      settings: { ...message().settings, maxVisible: 2 },
    })} />);

    expect(document.querySelector("[data-challenge-id=measure-ready] .challenge-source__count"))
      .toHaveTextContent("0 / 1500 · bereit");
    expect(document.querySelector("[data-challenge-id=measure-running] .challenge-source__count"))
      .toHaveTextContent("0 / 1500 · läuft");
  });

  it("zeigt beim Erledigen nach Ablauf die eingefrorene Überzeit weiter", () => {
    const doneOvertime = {
      ...timedChallenge("done-overtime", {
        title: "Nach Ablauf erledigt",
        state: "done",
        timerEndsAt: null,
        timerRemainMs: -1_000,
      }),
    };

    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      challenges: [doneOvertime],
    })} />);

    const row = document.querySelector<HTMLElement>("[data-challenge-id=done-overtime]");
    if (row === null) throw new Error("Überzeit-Zeile fehlt.");
    expect(row).toHaveClass("wc-is-overtime");
    expect(row.querySelector(".challenge-source__mark")).toHaveTextContent("✓");
    expect(row.querySelector(".challenge-source__time")).toHaveTextContent("+0:01");
    expect(row.querySelector(".challenge-source__time")).toHaveAttribute("data-state", "done");
  });

  it("übersteht die automatische Pong-Antwort auf den Heartbeat", async () => {
    // Das Durable Object beantwortet unseren Ping mit einem nackten "pong". Ohne
    // Sonderbehandlung landet das im Fehlerpfad für ein kaputtes Draht-Format:
    // die Quelle leert sich und lädt neu, 20s nach jedem Verbinden. Genau so ist
    // die Anzeige in Produktion verschwunden, bei weiterhin offenem Socket.
    const reloadPage = vi.fn();
    render(<ChallengeSourceApp reloadPage={reloadPage} />);
    const socket = FakeWebSocket.instances[0];
    await deliver(socket, message());
    await waitFor(() => expect(screen.getByText("CHALLENGES")).toBeInTheDocument());

    await act(async () => {
      socket?.emit("message", "pong");
      await Promise.resolve();
    });

    expect(screen.getByText("CHALLENGES")).toBeInTheDocument();
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it("feuert eine Zeremonie nur für ein neues Ereignis nach dem letzten Stand", async () => {
    render(<ChallengeSourceApp />);
    const socket = FakeWebSocket.instances[0];
    const ownSettings = { ...message().settings, themeMode: "own" as const };

    await deliver(socket, sourceUpdate({ eventSeq: 7, event: null, settings: ownSettings }));
    expect(document.querySelector(".challenge-source-ceremony")?.getAttribute("data-ceremony-type") ?? null).toBeNull();

    await deliver(socket, sourceUpdate({
      eventSeq: 8,
      event: { scope: "challenge", type: "progressed", challengeId: "open", delta: 1, previousCount: 3, currentCount: 4 },
      settings: ownSettings,
    }));
    expect(document.querySelector(".challenge-source-ceremony")).toHaveAttribute("data-ceremony-type", "progressed");

    await deliver(socket, sourceUpdate({
      eventSeq: 8,
      event: { scope: "challenge", type: "progressed", challengeId: "open", delta: 1, previousCount: 3, currentCount: 4 },
      settings: ownSettings,
    }));
    expect(document.querySelector(".challenge-source-ceremony")).toHaveAttribute("data-ceremony-type", "progressed");
    const tick = FakeAudio.instances.find((audio) => audio.src.endsWith("/tick.mp3"));
    expect(tick?.play).toHaveBeenCalledTimes(1);
  });

  it("lässt die ganze Zeremonie bei deaktivierten Effekten aus", async () => {
    render(<ChallengeSourceApp />);
    const socket = FakeWebSocket.instances[0];
    await deliver(socket, sourceUpdate({
      eventSeq: 1,
      settings: { ...message().settings, themeMode: "own", effectsEnabled: false },
      event: { scope: "challenge", type: "completed", challengeId: "open" },
    }));

    expect(document.querySelector(".challenge-source-ceremony")?.getAttribute("data-ceremony-type") ?? null).toBeNull();
    expect(FakeAudio.instances.every((audio) => audio.play.mock.calls.length === 0)).toBe(true);
  });

  it("behält bei reduziertem Motion-Wunsch die Zustandsänderung ohne Bewegung", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const completed = challenge("open", "Offene Challenge", "done", 0);
    render(<ChallengeSourceApp />);
    const socket = FakeWebSocket.instances[0];
    await deliver(socket, sourceUpdate({
      eventSeq: 1,
      challenges: [completed],
      settings: { ...message().settings, themeMode: "own" },
      event: { scope: "challenge", type: "completed", challengeId: "open" },
    }));

    const ceremony = document.querySelector(".challenge-source-ceremony");
    expect(ceremony).toHaveAttribute("data-ceremony-motion", "static");
    expect(ceremony?.querySelector('[data-challenge-id="open"]')).toHaveAttribute("data-state", "done");
    expect(ceremony?.querySelector('[data-challenge-id="open"] .challenge-source__mark')).toHaveTextContent("✓");
  });

  it("zeigt einen Streak-Fall bei reduced motion als lost-Zeremonie und spielt unabhängig davon den Tick", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const streak = {
      ...challenge("open", "Offene Streak", "pending", 1),
      kind: "streak" as const,
      targetCount: 5,
      currentCount: 0,
      bestCount: 4,
    };
    render(<ChallengeSourceApp />);
    const socket = FakeWebSocket.instances[0];
    await deliver(socket, sourceUpdate({
      challenges: [streak],
      settings: { ...message().settings, themeMode: "own" },
      event: { scope: "challenge", type: "streak-reset", challengeId: "open" },
    }));

    const ceremony = document.querySelector(".challenge-source-ceremony");
    expect(ceremony).toHaveAttribute("data-ceremony-type", "lost");
    expect(ceremony).toHaveAttribute("data-ceremony-motion", "static");
    expect(ceremony?.querySelector(".wc-is-streak-loss")).toHaveTextContent("0 / 5");
    const tick = FakeAudio.instances.find((audio) => audio.src.endsWith("/tick.mp3"));
    expect(tick?.play).toHaveBeenCalledTimes(1);
  });

  it("ignoriert verweigerte Tonwiedergabe ohne die visuelle Zeremonie zu verlieren", async () => {
    render(<ChallengeSourceApp />);
    const socket = FakeWebSocket.instances[0];
    const tick = FakeAudio.instances.find((audio) => audio.src.endsWith("/tick.mp3"));
    tick?.play.mockRejectedValueOnce(new Error("Autoplay verweigert"));

    await expect(deliver(socket, sourceUpdate({
      eventSeq: 1,
      settings: { ...message().settings, themeMode: "own" },
      event: { scope: "challenge", type: "progressed", challengeId: "open", delta: 1, previousCount: 3, currentCount: 4 },
    }))).resolves.toBeUndefined();
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector(".challenge-source-ceremony")).toHaveAttribute("data-ceremony-type", "progressed");
  });

  it.each(["plain-list", "plain-bullets"] as const)(
    "ordnet %s die gemeinsame Abschlusszeremonie zu",
    async (styleId) => {
      render(<ChallengeSourceApp />);
      const socket = FakeWebSocket.instances[0];
      await deliver(socket, sourceUpdate({
        eventSeq: 1,
        settings: { ...message().settings, styleId, themeMode: "own" },
        event: { scope: "challenge", type: "completed", challengeId: "open" },
      }));

      await waitFor(() => expect(document.querySelector(".challenge-source-ceremony")).toHaveAttribute("data-ceremony-type", "completed"));
      const complete = FakeAudio.instances.find((audio) => audio.src.endsWith("/complete.mp3"));
      expect(complete?.play).toHaveBeenCalledTimes(1);
    },
  );

  it("ordnet quest-log den eigenen Abschlussklang zu", async () => {
    render(<ChallengeSourceApp />);
    const socket = FakeWebSocket.instances[0];
    await deliver(socket, sourceUpdate({
      eventSeq: 1,
      settings: { ...message().settings, styleId: "quest-log", themeMode: "own" },
      event: { scope: "challenge", type: "completed", challengeId: "open" },
    }));

    await waitFor(() => expect(document.querySelector(".challenge-source-ceremony")).toHaveAttribute("data-ceremony-type", "completed"));
    const questComplete = FakeAudio.instances.find((audio) => audio.src.endsWith("/quest-complete.mp3"));
    expect(questComplete?.play).toHaveBeenCalledTimes(1);
    const complete = FakeAudio.instances.find((audio) => audio.src.endsWith("/complete.mp3"));
    expect(complete?.play).not.toHaveBeenCalled();
  });

  it("bremst zwei schnelle gleiche Töne auf eine Wiedergabe aus", async () => {
    render(<ChallengeSourceApp />);
    const socket = FakeWebSocket.instances[0];
    const settings = { ...message().settings, themeMode: "own" as const };
    const progressed = { scope: "challenge" as const, type: "progressed" as const, challengeId: "open", delta: 1, previousCount: 3, currentCount: 4 };
    await deliver(socket, sourceUpdate({ eventSeq: 1, settings, event: progressed }));
    await deliver(socket, sourceUpdate({ eventSeq: 2, settings, event: { ...progressed, previousCount: 4, currentCount: 5 } }));

    const tick = FakeAudio.instances.find((audio) => audio.src.endsWith("/tick.mp3"));
    expect(tick?.play.mock.calls.length ?? 0).toBe(1);
  });

  it("startet die sichtbare Zeremonie für jede neue Ereignisfolge neu", async () => {
    render(<ChallengeSourceApp />);
    const socket = FakeWebSocket.instances[0];
    const settings = { ...message().settings, themeMode: "own" as const };
    const progressed = { scope: "challenge" as const, type: "progressed" as const, challengeId: "open", delta: 1, previousCount: 3, currentCount: 4 };

    await deliver(socket, sourceUpdate({ eventSeq: 1, settings, event: progressed }));
    const firstCeremony = document.querySelector(".challenge-source-ceremony");
    const firstSource = document.querySelector(".challenge-source");
    const firstRow = document.querySelector('[data-challenge-id="open"]');
    const firstCount = document.querySelector('[data-challenge-id="open"] .challenge-source__count');
    await deliver(socket, sourceUpdate({ eventSeq: 2, settings, event: { ...progressed, previousCount: 4, currentCount: 5 } }));

    expect(document.querySelector(".challenge-source-ceremony")).toBe(firstCeremony);
    expect(document.querySelector(".challenge-source")).toBe(firstSource);
    expect(document.querySelector('[data-challenge-id="open"]')).toBe(firstRow);
    expect(document.querySelector('[data-challenge-id="open"] .challenge-source__count')).not.toBe(firstCount);

    await waitFor(() => expect(document.querySelector(".challenge-source-ceremony")).toHaveAttribute("data-ceremony-type", "progressed"));
    await waitFor(() => expect(document.querySelector(".challenge-source-ceremony")).not.toHaveAttribute("data-ceremony-type", "progressed"));
    expect(document.querySelector(".challenge-source")).toBe(firstSource);
    expect(document.querySelector('[data-challenge-id="open"]')).toBe(firstRow);
  });

  it("erzeugt Markierung und Zeileninneres je Zeremonie-Ereignis neu", () => {
    const update = sourceUpdate({ settings: { ...message().settings, themeMode: "own" } });
    const view = render(<ChallengeLog ceremonySeq={1} ceremonyTarget={{ kind: "challenge", id: "open" }} now={fixedNow} update={update} />);
    const row = document.querySelector('[data-challenge-id="open"]');
    const mark = row?.querySelector(".challenge-source__mark");
    const rowInner = row?.querySelector(".challenge-source__row-inner");

    view.rerender(<ChallengeLog ceremonySeq={2} ceremonyTarget={{ kind: "challenge", id: "open" }} now={fixedNow} update={update} />);

    expect(document.querySelector('[data-challenge-id="open"]')).toBe(row);
    expect(row?.querySelector(".challenge-source__mark")).not.toBe(mark);
    expect(row?.querySelector(".challenge-source__row-inner")).not.toBe(rowInner);
  });

  it("erzeugt den globalen Timer-Span je globaler Zeremonie neu", () => {
    const update = sourceUpdate({ settings: { ...message().settings, themeMode: "own", globalTimer: globalTimer("running") } });
    const view = render(<ChallengeLog ceremonySeq={1} ceremonyTarget={{ kind: "global" }} now={fixedNow} update={update} />);
    const timer = document.querySelector(".challenge-source__timer");

    view.rerender(<ChallengeLog ceremonySeq={2} ceremonyTarget={{ kind: "global" }} now={fixedNow} update={update} />);

    expect(document.querySelector(".challenge-source__timer")).not.toBe(timer);
  });

  it("zeigt das Ziel auch dann, wenn es sonst außerhalb der sichtbaren Zeilen läge", async () => {
    render(<ChallengeSourceApp />);
    const socket = FakeWebSocket.instances[0];
    const challenges = [
      challenge("first", "Erste Challenge", "pending", 0),
      challenge("second", "Zweite Challenge", "pending", 1),
      challenge("third", "Dritte Challenge", "pending", 2),
      challenge("fourth", "Vierte Challenge", "pending", 3),
      challenge("fifth", "Fünfte Challenge", "pending", 4),
      challenge("target", "Ziel außerhalb der Auswahl", "pending", 5),
    ];
    await deliver(socket, sourceUpdate({
      eventSeq: 1,
      challenges,
      settings: { ...message().settings, themeMode: "own" },
      event: { scope: "challenge", type: "progressed", challengeId: "target", delta: 1, previousCount: 3, currentCount: 4 },
    }));

    expect(document.querySelector('[data-challenge-id="target"]')).toHaveAttribute("data-ceremony-target", "true");
    expect(document.querySelectorAll('.challenge-source__row[data-state="pending"]')).toHaveLength(5);
    expect(screen.getByText("+1 weitere")).toBeInTheDocument();
  });

  it("blendet das Log bei Parse-Fehlern aus und zeigt es bei der nächsten gültigen Nachricht wieder", async () => {
    const reloadPage = vi.fn();
    render(<ChallengeSourceApp reloadPage={reloadPage} />);
    const socket = FakeWebSocket.instances[0];
    await deliver(socket, message());
    expect(screen.getByText("Offene Challenge")).toBeInTheDocument();
    act(() => socket?.emit("message", JSON.stringify({ ...message(), settings: { ...message().settings, overflowMode: "invalid" } })));
    expect(document.body).not.toHaveTextContent("Offene Challenge");
    expect(reloadPage).toHaveBeenCalledTimes(1);
    await deliver(socket, message());
    expect(screen.getByText("Offene Challenge")).toBeInTheDocument();
  });

  it("lädt bei zwei Parse-Fehlern innerhalb der Sperrfrist nur einmal neu", () => {
    const reloadPage = vi.fn();
    render(<ChallengeSourceApp reloadPage={reloadPage} />);
    const socket = FakeWebSocket.instances[0];

    act(() => socket?.emit("message", "kein JSON"));
    act(() => socket?.emit("message", JSON.stringify({ type: "challenge_update" })));

    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem("wc-parse-reload-at")).not.toBeNull();
  });

  it("lädt bei nicht verfügbarem sessionStorage nicht neu", () => {
    const reloadPage = vi.fn();
    const descriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get: () => {
        throw new Error("sessionStorage unavailable");
      },
    });

    try {
      render(<ChallengeSourceApp reloadPage={reloadPage} />);
      act(() => FakeWebSocket.instances[0]?.emit("message", "kein JSON"));
      expect(reloadPage).not.toHaveBeenCalled();
    } finally {
      if (descriptor !== undefined) Object.defineProperty(window, "sessionStorage", descriptor);
    }
  });

  it("lädt bei token_revoked nicht neu", () => {
    const reloadPage = vi.fn();
    render(<ChallengeSourceApp reloadPage={reloadPage} />);
    act(() => FakeWebSocket.instances[0]?.emit("message", JSON.stringify({ type: "token_revoked" })));
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it("spielt für versteckte Challenge-Events keine Zeremonie und keinen Ton, sichtbare aber schon", async () => {
    const reloadPage = vi.fn();
    render(<ChallengeSourceApp reloadPage={reloadPage} />);
    const socket = FakeWebSocket.instances[0];
    const settings = { ...message().settings, themeMode: "own" as const };
    const hiddenChallenge = { ...challenge("open", "Bonus", "pending", 1), hidden: true };
    const hiddenEvent = {
      scope: "challenge" as const,
      type: "progressed" as const,
      challengeId: "open",
      delta: 1,
      previousCount: 3,
      currentCount: 4,
    };

    await deliver(socket, sourceUpdate({
      eventSeq: 1,
      challenges: [challenge("done", "Erledigt unten", "done", 0), hiddenChallenge],
      settings,
      event: hiddenEvent,
    }));
    expect(document.querySelector(".challenge-source-ceremony")?.getAttribute("data-ceremony-type") ?? null).toBeNull();
    const tick = FakeAudio.instances.find((audio) => audio.src.endsWith("/tick.mp3"));
    expect(tick?.play).not.toHaveBeenCalled();

    await deliver(socket, sourceUpdate({
      eventSeq: 2,
      challenges: [challenge("done", "Erledigt unten", "done", 0), { ...hiddenChallenge, hidden: false }],
      settings,
      event: hiddenEvent,
    }));
    expect(document.querySelector(".challenge-source-ceremony")).toHaveAttribute("data-ceremony-type", "progressed");
    expect(tick?.play).toHaveBeenCalledTimes(1);
  });

  it("hält die Quelle bis zum Theme-Chunk transparent", async () => {
    const theme = deferred();
    const loadTheme = vi.fn(() => theme.promise);
    render(<ChallengeSourceApp loadTheme={loadTheme} />);
    const socket = FakeWebSocket.instances[0];

    await deliver(socket, message());
    expect(document.body).not.toHaveTextContent("Offene Challenge");
    expect(loadTheme).toHaveBeenCalledWith("trail-wood");

    await act(async () => {
      theme.resolve();
      await theme.promise;
    });
    expect(screen.getByText("Offene Challenge")).toBeInTheDocument();
    expect(document.querySelector(".challenge-source")).toHaveClass("hud-theme--trail-wood");
  });

  it("hält die Quelle bis zum Style-Chunk transparent", async () => {
    const style = deferred();
    const loadStyle = vi.fn(() => style.promise);
    render(<ChallengeSourceApp loadStyle={loadStyle} />);
    const socket = FakeWebSocket.instances[0];

    await deliver(socket, sourceUpdate({ settings: { ...message().settings, themeMode: "own" } }));
    expect(document.body).not.toHaveTextContent("Offene Challenge");
    expect(loadStyle).toHaveBeenCalledWith("plain-list");

    await act(async () => {
      style.resolve();
      await style.promise;
    });
    expect(screen.getByText("Offene Challenge")).toBeInTheDocument();
  });

  it("bleibt bei einem fehlgeschlagenen Style-Chunk transparent", async () => {
    const style = deferred();
    const loadStyle = vi.fn(() => style.promise);
    render(<ChallengeSourceApp loadStyle={loadStyle} />);
    const socket = FakeWebSocket.instances[0];

    await deliver(socket, sourceUpdate({ settings: { ...message().settings, themeMode: "own" } }));
    await act(async () => {
      style.reject(new Error("Style-Chunk fehlgeschlagen"));
      await expect(style.promise).rejects.toThrow("Style-Chunk fehlgeschlagen");
    });
    expect(document.body).not.toHaveTextContent("Offene Challenge");
  });

  it("verwirft einen überholten Style-Import", async () => {
    const styles = new Map<ChallengeStyleId, ReturnType<typeof deferred>>();
    const loadStyle = vi.fn((styleId: ChallengeStyleId) => {
      const request = deferred();
      styles.set(styleId, request);
      return request.promise;
    });
    render(<ChallengeSourceApp loadStyle={loadStyle} />);
    const socket = FakeWebSocket.instances[0];

    await deliver(socket, sourceUpdate({ settings: { ...message().settings, themeMode: "own" } }));
    await deliver(socket, sourceUpdate({
      settings: { ...message().settings, styleId: "quest-log", themeMode: "own" },
    }));

    await act(async () => {
      styles.get("quest-log")?.resolve();
      await styles.get("quest-log")?.promise;
    });
    expect(document.querySelector(".challenge-source")).toHaveAttribute("data-style", "quest-log");

    await act(async () => {
      styles.get("plain-list")?.resolve();
      await styles.get("plain-list")?.promise;
    });
    expect(document.querySelector(".challenge-source")).toHaveAttribute("data-style", "quest-log");
  });

  it("bleibt bei einem fehlgeschlagenen Theme-Chunk transparent", async () => {
    const theme = deferred();
    const loadTheme = vi.fn(() => theme.promise);
    render(<ChallengeSourceApp loadTheme={loadTheme} />);
    const socket = FakeWebSocket.instances[0];

    await deliver(socket, message());
    await act(async () => {
      theme.reject();
      await expect(theme.promise).rejects.toThrow("Theme-Chunk fehlgeschlagen");
    });
    expect(document.body).not.toHaveTextContent("Offene Challenge");
  });

  it("verwirft einen überholten Theme-Import", async () => {
    const themes = new Map<ChallengeThemeId, ReturnType<typeof deferred>>();
    const loadTheme = vi.fn((themeId: ChallengeThemeId) => {
      const request = deferred();
      themes.set(themeId, request);
      return request.promise;
    });
    render(<ChallengeSourceApp loadTheme={loadTheme} />);
    const socket = FakeWebSocket.instances[0];

    await deliver(socket, message());
    await deliver(socket, sourceUpdate({
      settings: { ...message().settings, themeId: "modern-compact" },
    }));

    await act(async () => {
      themes.get("modern-compact")?.resolve();
      await themes.get("modern-compact")?.promise;
    });
    expect(document.querySelector(".challenge-source")).toHaveClass("hud-theme--modern-compact");

    await act(async () => {
      themes.get("trail-wood")?.resolve();
      await themes.get("trail-wood")?.promise;
    });
    expect(document.querySelector(".challenge-source")).toHaveClass("hud-theme--modern-compact");
    expect(document.querySelector(".challenge-source")).not.toHaveClass("hud-theme--trail-wood");
  });

  it("schaltet von inherit auf own um, obwohl der geladene Theme-Chunk bleibt", async () => {
    const theme = deferred();
    const loadTheme = vi.fn(() => theme.promise);
    render(<ChallengeSourceApp loadTheme={loadTheme} />);
    const socket = FakeWebSocket.instances[0];

    await deliver(socket, message());
    await act(async () => {
      theme.resolve();
      await theme.promise;
    });
    expect(document.querySelector(".challenge-source")).toHaveClass("hud-theme--trail-wood");

    await deliver(socket, sourceUpdate({
      settings: { ...message().settings, themeMode: "own" },
    }));
    expect(screen.getByText("Offene Challenge")).toBeInTheDocument();
    expect(document.querySelector(".challenge-source")).not.toHaveClass("hud-theme--trail-wood");
  });

  it("lädt einen Theme-Wechsel allein über das nächste challenge_update", async () => {
    const themes = new Map<ChallengeThemeId, ReturnType<typeof deferred>>();
    const loadTheme = vi.fn((themeId: ChallengeThemeId) => {
      const request = deferred();
      themes.set(themeId, request);
      return request.promise;
    });
    render(<ChallengeSourceApp loadTheme={loadTheme} />);
    const socket = FakeWebSocket.instances[0];

    await deliver(socket, message());
    await act(async () => {
      themes.get("trail-wood")?.resolve();
      await themes.get("trail-wood")?.promise;
    });

    await deliver(socket, sourceUpdate({
      eventSeq: 1,
      settings: { ...message().settings, themeId: "field-journal" },
    }));
    expect(loadTheme).toHaveBeenLastCalledWith("field-journal");
    expect(document.body).not.toHaveTextContent("Offene Challenge");

    await act(async () => {
      themes.get("field-journal")?.resolve();
      await themes.get("field-journal")?.promise;
    });
    await waitFor(() => expect(document.querySelector(".challenge-source")).toHaveClass("hud-theme--field-journal"));
  });

  it("rendert im eigenen Theme ohne HUD-Theme-Import mit den Modul-Tokens", () => {
    const current = message();
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      settings: { ...current.settings, themeMode: "own" },
    })} />);

    const source = document.querySelector(".challenge-source");
    expect(source).toHaveAttribute("data-theme-mode", "own");
    expect(source).not.toHaveClass("hud-theme--trail-wood");
    expect(source).toHaveAttribute("data-style", "plain-list");
  });

  it.each(styleNames)("rendert dieselben Daten lesbar im %s-Style für Fläche und ohne Fläche", (styleId) => {
    const visibleDone = { ...challenge("done", "Erledigt unten", "done", 0), completedAt: new Date(fixedNow).toISOString() };
    const visibleUpdate = sourceUpdate({
      challenges: [visibleDone, challenge("open", "Offene Challenge", "pending", 1)],
    });
    for (const surfaceOpacity of [100, 0] as const) {
      const view = render(<ChallengeLog now={fixedNow} update={{
        ...visibleUpdate,
        settings: { ...visibleUpdate.settings, styleId, surfaceOpacity, themeMode: "own" },
      }} />);

      const source = document.querySelector(".challenge-source");
      expect(source).toHaveAttribute("data-style", styleId);
      expect(source).toHaveAttribute("data-surface-mode", surfaceOpacity === 0 ? "bare" : "surface");
      expect(screen.getByText("Offene Challenge")).toBeInTheDocument();
      expect(screen.getByText("Erledigt unten")).toBeInTheDocument();
      const rows = [...document.querySelectorAll(".challenge-source__row")];
      expect(rows.at(-1)).toHaveAttribute("data-state", "done");
      expect(rows.at(-1)?.querySelector(".challenge-source__mark")).toHaveTextContent("✓");

      view.unmount();
    }
  });

  it("leitet bei 25 Prozent das Bare-Preset ab und setzt die Flächenopazität", () => {
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      settings: { ...message().settings, surfaceOpacity: 25 },
    })} />);

    const source = document.querySelector(".challenge-source");
    expect(source).toHaveAttribute("data-surface-mode", "bare");
    expect(source).toHaveStyle("--wc-surface-opacity: 0.25");
  });

  it("löst den Schrifteffekt unabhängig von der Flächenopazität auf", () => {
    const cases = [
      { label: "automatisch bei voller Deckkraft", surfaceOpacity: 100 as const, textEmphasis: "auto" as const, expectedEmphasis: "plain", expectedSurface: "surface" },
      { label: "automatisch bei 25 Prozent", surfaceOpacity: 25 as const, textEmphasis: "auto" as const, expectedEmphasis: "strong", expectedSurface: "bare" },
      { label: "kräftig bei voller Deckkraft", surfaceOpacity: 100 as const, textEmphasis: "strong" as const, expectedEmphasis: "strong", expectedSurface: "surface" },
    ] as const;

    for (const testCase of cases) {
      const view = render(<ChallengeLog now={fixedNow} update={sourceUpdate({
        settings: { ...message().settings, surfaceOpacity: testCase.surfaceOpacity, textEmphasis: testCase.textEmphasis },
      })} />);
      const source = document.querySelector(".challenge-source");
      expect(source, testCase.label).toHaveAttribute("data-text-emphasis", testCase.expectedEmphasis);
      expect(source, testCase.label).toHaveAttribute("data-surface-mode", testCase.expectedSurface);
      view.unmount();
    }
  });

  it("belässt bei 50 Prozent das Surface-Preset", () => {
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      settings: { ...message().settings, surfaceOpacity: 50 },
    })} />);

    expect(document.querySelector(".challenge-source")).toHaveAttribute("data-surface-mode", "surface");
  });

  it("trägt den invertierten Kopfzeilen-Stil am Wurzelelement", () => {
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      settings: { ...message().settings, headerStyle: "inverted" },
    })} />);

    expect(document.querySelector(".challenge-source")).toHaveAttribute("data-header-style", "inverted");
  });

  it("trägt Schriftart und Schriftgrößenfaktor am Wurzelelement", () => {
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      settings: { ...message().settings, fontFamily: "mono", fontScale: 1.5 },
    })} />);

    const source = document.querySelector(".challenge-source");
    expect(source).toHaveAttribute("data-font-family", "mono");
    expect(source).toHaveStyle("--wc-font-scale: 1.5");
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

  it("zeigt die gepflegte Strafen-Beschriftung und hält ein leeres Label unsichtbar", () => {
    const current = message();
    const view = render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      settings: { ...current.settings, penaltyLabel: "Konsequenz", penaltyText: "Keine Pizza für dich" },
    })} />);

    expect(document.querySelector(".challenge-source__penalty-label")).toHaveTextContent("Konsequenz");
    expect(document.querySelector(".challenge-source__penalty-text")).toHaveTextContent("Keine Pizza für dich");

    view.rerender(<ChallengeLog now={fixedNow} update={sourceUpdate({
      settings: { ...current.settings, penaltyLabel: "   ", penaltyText: "Keine Pizza für dich" },
    })} />);
    expect(document.querySelector(".challenge-source__penalty-label")).toBeNull();
    expect(document.querySelector(".challenge-source__penalty-text")).toHaveTextContent("Keine Pizza für dich");
  });

  it("blättert synchron durch Seiten, hält die gepinnte Challenge fest und zieht Zeremonienziele auf die aktuelle Seite", () => {
    const challenges = Array.from({ length: 6 }, (_, index) => challenge(`page-${String(index)}`, `Seite ${String(index)}`, "pending", index));
    const update = sourceUpdate({ challenges, settings: { ...message().settings, overflowMode: "page" } });
    const view = render(<ChallengeLog now={0} update={update} />);
    expect(document.querySelectorAll(".challenge-source__row")).toHaveLength(5);
    expect(screen.getByText(/· 1\/2$/)).toBeInTheDocument();
    expect(screen.queryByText("Seite 5")).not.toBeInTheDocument();

    view.rerender(<ChallengeLog now={8_000} update={update} />);
    expect(screen.getByText("Seite 5")).toBeInTheDocument();
    expect(screen.getByText(/· 2\/2$/)).toBeInTheDocument();

    const pinned = { ...challenge("pinned", "Gepinnt", "pending", 0), state: "active" as const, timerEndsAt: new Date(fixedNow + 30_000).toISOString() };
    const withPinned = sourceUpdate({
      challenges: [pinned, ...challenges.slice(1)],
      settings: { ...message().settings, overflowMode: "page" },
    });
    view.rerender(<ChallengeLog now={8_000} update={withPinned} />);
    expect(screen.getByText("Gepinnt")).toBeInTheDocument();
    expect(screen.getByText("Seite 5")).toBeInTheDocument();
    expect(document.querySelectorAll(".challenge-source__row")).toHaveLength(2);

    view.rerender(<ChallengeLog ceremonyTarget={{ kind: "challenge", id: "page-0" }} now={8_000} update={update} />);
    expect(screen.getByText("Seite 0")).toBeInTheDocument();
    expect(screen.queryByText("Seite 5")).not.toBeInTheDocument();
  });

  it("zeigt die Nummer in der Markierungsspalte, erledigt bekommt trotzdem den Haken", () => {
    const done = { ...challenge("done-number", "Erledigt nummeriert", "done", 1), completedAt: new Date(fixedNow).toISOString() };
    const update = sourceUpdate({
      challenges: [challenge("open-number", "Offen nummeriert", "pending", 0), done],
      settings: { ...message().settings, numbered: true },
    });
    const view = render(<ChallengeLog now={fixedNow} update={update} />);
    const openMark = document.querySelector('[data-challenge-id="open-number"] .challenge-source__mark');
    const doneMark = document.querySelector('[data-challenge-id="done-number"] .challenge-source__mark');
    expect(openMark).toHaveTextContent("1");
    // Erledigt schlägt Nummerierung: der grüne Haken ist das Signal, die Nummer
    // wäre hier nur noch Buchhaltung.
    expect(doneMark).toHaveTextContent("✓");
    expect(doneMark).not.toHaveTextContent("2");

    view.rerender(<ChallengeLog now={fixedNow} update={sourceUpdate({
      challenges: [challenge("quest-number", "Quest nummeriert", "pending", 0)],
      settings: { ...message().settings, styleId: "quest-log", numbered: true },
    })} />);
    expect(document.querySelector(".challenge-source__mark")).toHaveTextContent("1");
    expect(document.querySelector(".challenge-source__mark")).not.toHaveTextContent("◆");
  });

  it("ersetzt bei sichtbaren Keys die Nummer, lässt erledigte Zeilen beim Haken und benennt den Key zugänglich", () => {
    const done = { ...challenge("done-key", "Erledigt mit Key", "done", 1), completedAt: new Date(fixedNow).toISOString() };
    const update = sourceUpdate({
      challenges: [challenge("open-key", "Offen mit Key", "pending", 0), done],
      settings: { ...message().settings, numbered: true, keyVisible: true },
    });
    const view = render(<ChallengeLog ariaLabel="Challenge-Log verschieben, Pfeiltasten" now={fixedNow} update={update} />);
    const openMark = document.querySelector('[data-challenge-id="open-key"] .challenge-source__mark');
    const doneMark = document.querySelector('[data-challenge-id="done-key"] .challenge-source__mark');

    expect(openMark).toHaveTextContent("K7RP");
    expect(openMark).not.toHaveTextContent("1");
    expect(openMark).toHaveClass("challenge-source__mark--key");
    expect(openMark).toHaveAttribute("aria-label", "Steuer-Key K7RP");
    expect(openMark).not.toHaveAttribute("aria-hidden");
    expect(doneMark).toHaveTextContent("✓");
    expect(doneMark).not.toHaveTextContent("K7RP");

    view.rerender(<ChallengeLog now={fixedNow} update={sourceUpdate({
      challenges: [challenge("numbered-only", "Nur nummeriert", "pending", 0)],
      settings: { ...message().settings, numbered: true, keyVisible: false },
    })} />);
    const numberedMark = document.querySelector(".challenge-source__mark");
    expect(numberedMark).toHaveTextContent("1");
    expect(numberedMark).not.toHaveTextContent("K7RP");
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

  it("markiert den Global-Timer als Zeremonieziel und blendet einen idle Timer aus", () => {
    const update = sourceUpdate({
      settings: { ...message().settings, globalTimer: globalTimer("running") },
    });
    const view = render(<ChallengeLog ceremonyTarget={{ kind: "global" }} now={fixedNow} update={update} />);
    expect(screen.getByLabelText(/Globaler Timer/)).toHaveAttribute("data-ceremony-target", "true");

    view.rerender(<ChallengeLog now={fixedNow} update={sourceUpdate({
      settings: {
        ...message().settings,
        globalTimer: { totalMs: 60_000, endsAt: null, pausedRemainMs: null },
      },
    })} />);
    expect(screen.queryByLabelText(/Globaler Timer/)).not.toBeInTheDocument();
  });

  it("zeigt erledigte Challenges dauerhaft auch ohne aktiven Timer", () => {
    const old = { ...challenge("old", "Alte Challenge", "done", 0), completedAt: "2026-08-31T11:59:00.000Z" };
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({ challenges: [old] })} />);
    expect(screen.getByText("Alte Challenge")).toBeInTheDocument();
    expect(screen.getByText("✓")).toBeInTheDocument();
  });

  it("zeigt pausierte Restzeit offen und eingefrorene Restzeit beim Abhaken", () => {
    const paused = {
      ...challenge("paused", "Pausiert", "pending", 0),
      timerTotalMs: 60_000,
      timerRemainMs: 192_000,
    };
    const view = render(<ChallengeLog now={fixedNow} update={sourceUpdate({ challenges: [paused] })} />);

    const pausedTime = document.querySelector(".challenge-source__time");
    expect(pausedTime).toHaveTextContent("Ⅱ 3:12");
    expect(pausedTime).toHaveAttribute("data-state", "paused");
    expect(pausedTime).toHaveAttribute("aria-label", "Restzeit 3:12");

    const done = {
      ...paused,
      state: "done" as const,
      timerEndsAt: null,
      timerRemainMs: 0,
      completedAt: new Date(fixedNow).toISOString(),
    };
    view.rerender(<ChallengeLog now={fixedNow} update={sourceUpdate({ challenges: [done] })} />);
    const doneTime = document.querySelector(".challenge-source__time");
    expect(doneTime).toHaveTextContent("0:00");
    expect(doneTime).toHaveAttribute("data-state", "done");
    expect(doneTime).toHaveAttribute("aria-label", "Rest bei Abschluss 0:00");
  });

  it("liest Übererfüllung eines Messwerts über den geklemmten ARIA-Wert vor", () => {
    const overfulfilled = {
      ...challenge("measure", "Messwert", "pending", 0),
      kind: "measure" as const,
      unit: "m",
      targetCount: 1_500,
      currentCount: 1_800,
    };
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({ challenges: [overfulfilled] })} />);

    const progressbar = screen.getByRole("progressbar");
    expect(progressbar).toHaveAttribute("aria-valuemax", "1500");
    expect(progressbar).toHaveAttribute("aria-valuenow", "1500");
    expect(progressbar).toHaveAttribute("aria-valuetext", "1800 von 1500 (übererfüllt)");
  });

  it("setzt Zeitleisten-Zustand und Variablen für jeden Challenge-Timer-Zustand", () => {
    vi.useFakeTimers({ now: fixedNow });
    try {
      const running = timedChallenge("running", {
        timerEndsAt: new Date(fixedNow + 120_000).toISOString(),
      });
      const paused = timedChallenge("paused", {
        timerRemainMs: 45_000,
      });
      const expired = timedChallenge("expired", {
        timerEndsAt: new Date(fixedNow - 1_000).toISOString(),
      });
      const overtime = timedChallenge("overtime", {
        timerRemainMs: -1_000,
      });
      const done = timedChallenge("done", {
        state: "done",
        timerRemainMs: 45_000,
        completedAt: new Date(fixedNow).toISOString(),
      });
      const withoutTimer = challenge("without-timer", "without-timer", "pending", 0);

      render(<ChallengeLog now={fixedNow} update={sourceUpdate({
        challenges: [running, paused, expired, overtime, done, withoutTimer],
        settings: { ...message().settings, maxVisible: 6 },
      })} />);

      const row = (id: string): HTMLElement => {
        const element = document.querySelector<HTMLElement>(`[data-challenge-id="${id}"]`);
        if (element === null) throw new Error(`Zeile ${id} fehlt`);
        return element;
      };
      const runningRow = row("running");
      expect(runningRow).toHaveAttribute("data-timer-state", "running");
      expect(runningRow).not.toHaveAttribute("data-timer-critical");
      expect(runningRow.style.getPropertyValue("--wc-timer-total")).toBe("120000ms");
      expect(runningRow.style.getPropertyValue("--wc-timer-delay")).toBe("-0ms");
      expect(runningRow.style.getPropertyValue("--wc-timer-scale")).toBe("1");
      expect(runningRow.querySelector(".challenge-source__time")).toBeInTheDocument();
      expect(runningRow.querySelector(".challenge-source__progress")).toBeNull();

      const pausedRow = row("paused");
      expect(pausedRow).toHaveAttribute("data-timer-state", "paused");
      expect(pausedRow).not.toHaveAttribute("data-timer-critical");
      expect(pausedRow.style.getPropertyValue("--wc-timer-total")).toBe("120000ms");
      expect(pausedRow.style.getPropertyValue("--wc-timer-delay")).toBe("-75000ms");
      expect(pausedRow.style.getPropertyValue("--wc-timer-scale")).toBe("0.375");

      const expiredRow = row("expired");
      expect(expiredRow).toHaveAttribute("data-timer-state", "expired");
      expect(expiredRow).toHaveClass("wc-is-overtime");
      expect(expiredRow).not.toHaveAttribute("data-timer-critical");
      expect(expiredRow.style.getPropertyValue("--wc-timer-total")).toBe("120000ms");
      expect(expiredRow.style.getPropertyValue("--wc-timer-delay")).toBe("-120000ms");
      expect(expiredRow.style.getPropertyValue("--wc-timer-scale")).toBe("0");

      const overtimeRow = row("overtime");
      expect(overtimeRow).toHaveAttribute("data-timer-state", "paused");
      expect(overtimeRow).toHaveClass("wc-is-overtime");
      expect(overtimeRow.style.getPropertyValue("--wc-timer-scale")).toBe("0");
      expect(overtimeRow.querySelector(".challenge-source__time")).toHaveTextContent("Ⅱ +0:01");

      const doneRow = row("done");
      expect(doneRow).not.toHaveAttribute("data-timer-state");
      expect(doneRow).not.toHaveClass("wc-is-overtime");
      expect(doneRow).not.toHaveAttribute("data-timer-critical");
      expect(doneRow.style.getPropertyValue("--wc-timer-total")).toBe("120000ms");
      expect(doneRow.style.getPropertyValue("--wc-timer-delay")).toBe("-75000ms");
      expect(doneRow.style.getPropertyValue("--wc-timer-scale")).toBe("0.375");

      const withoutTimerRow = row("without-timer");
      expect(withoutTimerRow).not.toHaveAttribute("data-timer-state");
      expect(withoutTimerRow).not.toHaveAttribute("data-timer-critical");
      expect(withoutTimerRow.style.getPropertyValue("--wc-timer-total")).toBe("");
      expect(withoutTimerRow.style.getPropertyValue("--wc-timer-delay")).toBe("");
      expect(withoutTimerRow.style.getPropertyValue("--wc-timer-scale")).toBe("0");
      expect(withoutTimerRow.querySelector(".challenge-source__time")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("setzt die kritische Zeitleiste erst unter 30 Sekunden und nur im Lauf", () => {
    vi.useFakeTimers({ now: fixedNow });
    try {
      const view = render(<ChallengeLog now={fixedNow} update={sourceUpdate({
        challenges: [timedChallenge("critical", {
          timerEndsAt: new Date(fixedNow + 29_999).toISOString(),
        })],
      })} />);
      const row = document.querySelector<HTMLElement>('[data-challenge-id="critical"]');
      expect(row).toHaveAttribute("data-timer-state", "running");
      expect(row).toHaveAttribute("data-timer-critical", "true");

      view.rerender(<ChallengeLog now={fixedNow} update={sourceUpdate({
        challenges: [timedChallenge("critical", {
          timerEndsAt: new Date(fixedNow + 30_000).toISOString(),
        })],
      })} />);
      expect(row).not.toHaveAttribute("data-timer-critical");

      view.rerender(<ChallengeLog now={fixedNow} update={sourceUpdate({
        challenges: [timedChallenge("critical", { timerRemainMs: 1_000 })],
      })} />);
      expect(row).toHaveAttribute("data-timer-state", "paused");
      expect(row).not.toHaveAttribute("data-timer-critical");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hält Dauer und Verzögerung über Sekundenticks stabil", () => {
    vi.useFakeTimers({ now: fixedNow });
    try {
      const challengeWithTimer = timedChallenge("long", {
        timerEndsAt: new Date(fixedNow + 120_000).toISOString(),
      });
      const view = render(<ChallengeLog now={fixedNow} update={sourceUpdate({ challenges: [challengeWithTimer] })} />);
      const row = document.querySelector<HTMLElement>('[data-challenge-id="long"]');
      if (row === null) throw new Error("Timer-Zeile fehlt");
      const totalBefore = row.style.getPropertyValue("--wc-timer-total");
      const delayBefore = row.style.getPropertyValue("--wc-timer-delay");
      const scaleBefore = row.style.getPropertyValue("--wc-timer-scale");

      view.rerender(<ChallengeLog now={fixedNow + 2_000} update={sourceUpdate({ challenges: [challengeWithTimer] })} />);

      expect(row.style.getPropertyValue("--wc-timer-total")).toBe(totalBefore);
      expect(row.style.getPropertyValue("--wc-timer-delay")).toBe(delayBefore);
      expect(row.style.getPropertyValue("--wc-timer-scale")).not.toBe(scaleBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("zeigt bei offenen Challenges ohne laufenden oder pausierten Timer keine Restzeit", () => {
    const view = render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      challenges: [challenge("open", "Offen", "pending", 0)],
    })} />);

    expect(document.querySelector(".challenge-source__time")).toBeNull();

    view.rerender(<ChallengeLog now={fixedNow} update={sourceUpdate({
      challenges: [{
        ...challenge("expired", "Abgelaufen", "pending", 0),
        timerTotalMs: 60_000,
        state: "active",
        timerEndsAt: new Date(fixedNow - 1_000).toISOString(),
      }],
    })} />);
    expect(document.querySelector(".challenge-source__time")).toHaveTextContent("+0:01");
    expect(document.querySelector(".challenge-source__time")).toHaveAttribute("data-state", "expired");
  });

  it("zeigt einen abgelaufenen globalen Timer als Überzeit ohne kritischen Alarm", () => {
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      settings: { ...message().settings, globalTimer: globalTimer("expired") },
    })} />);

    const timer = screen.getByLabelText("Globaler Timer: +0:01, abgelaufen");
    expect(timer).toHaveTextContent("+0:01");
    expect(timer).toHaveAttribute("data-state", "expired");
    expect(timer).toHaveClass("wc-is-overtime");
    expect(timer).toHaveAttribute("data-critical", "false");
  });

  it("markiert eine pausierte negative globale Restzeit ebenfalls als Überzeit", () => {
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      settings: {
        ...message().settings,
        globalTimer: { totalMs: 60_000, endsAt: null, pausedRemainMs: -1_000 },
      },
    })} />);

    const timer = screen.getByLabelText("Globaler Timer: +0:01, pausiert");
    expect(timer).toHaveClass("challenge-source__timer--paused");
    expect(timer).toHaveClass("wc-is-overtime");
  });

  it("zeigt erledigte Challenges auch bei laufendem globalem Timer", () => {
    const old = { ...challenge("old", "Alte Challenge", "done", 0), completedAt: "2026-08-31T11:59:00.000Z" };
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      challenges: [old],
      settings: { ...message().settings, globalTimer: globalTimer("running") },
    })} />);
    expect(screen.getByText("CHALLENGES")).toBeInTheDocument();
    expect(screen.getByLabelText(/Globaler Timer/)).toBeInTheDocument();
    expect(screen.getByText("Alte Challenge")).toBeInTheDocument();
  });

  it("zeigt bei mindestens einer offenen Challenge den vollständigen Zustand", () => {
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      challenges: [challenge("open", "Offene Challenge", "pending", 0)],
    })} />);
    expect(screen.getByText("Offene Challenge")).toBeInTheDocument();
    expect(screen.getByText("3 / 10")).toBeInTheDocument();
  });

  it("filtert versteckte Challenges, zeigt den Stand aber inklusive Versteckter", () => {
    const hidden = { ...challenge("hidden", "Versteckter Bonus", "pending", 0), hidden: true };
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      challenges: [hidden, challenge("open", "Offene Challenge", "pending", 1)],
    })} />);

    expect(screen.queryByText("Versteckter Bonus")).not.toBeInTheDocument();
    expect(screen.getByText("0 / 1(+1)")).toBeInTheDocument();
  });

  it("markiert fertige Zeilen eindeutig und blendet einen alten Challenge-Timer aus", () => {
    const done = {
      ...challenge("done", "Erledigt", "done", 0),
      currentCount: 0,
      timerEndsAt: "2026-08-31T12:00:10.000Z",
    };
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({ challenges: [done] })} />);

    const row = document.querySelector('[data-challenge-id="done"]');
    expect(row?.querySelector(".challenge-source__mark")).toHaveTextContent("✓");
    expect(row?.querySelector(".challenge-source__progress")).toHaveAttribute("style", "--wc-progress: 100%;");
    expect(row?.querySelector(".challenge-source__time")).toBeNull();
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

  it("zeigt im Hochzählmodus die verstrichene Zeit ohne kritischen Zustand", () => {
    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      settings: { ...message().settings, globalTimerMode: "up", globalTimer: globalTimer("running") },
    })} />);
    const timer = screen.getByLabelText("Globaler Timer: 0:30, hochzählend");
    expect(timer).toHaveTextContent("▴");
    expect(timer).toHaveTextContent("0:30");
    expect(timer).toHaveAttribute("data-critical", "false");
    expect(timer).not.toHaveTextContent("kritisch");

    render(<ChallengeLog now={fixedNow} update={sourceUpdate({
      settings: { ...message().settings, globalTimerMode: "up", globalTimer: globalTimer("expired") },
    })} />);
    const expired = screen.getByLabelText("Globaler Timer: 1:00, hochzählend");
    expect(expired).toHaveTextContent("1:00");
    expect(expired).toHaveAttribute("data-state", "expired");
    expect(expired).toHaveAttribute("data-critical", "false");
    expect(expired).not.toHaveClass("challenge-source__timer--expired");
    expect(expired).not.toHaveClass("wc-is-overtime");
    expect(expired).not.toHaveTextContent("abgelaufen");
  });

  it("zeigt den Überlauf mit der eingestellten Kapazität", () => {
    const openChallenges = Array.from({ length: 10 }, (_, index) => challenge(`open-${String(index)}`, `Offen ${String(index)}`, "pending", index));
    const finishedChallenges = Array.from({ length: 30 }, (_, index) => ({
      ...challenge(`done-${String(index)}`, `Fertig ${String(index)}`, "done", index + 10),
      completedAt: new Date(fixedNow - 1_000).toISOString(),
    }));
    const update = sourceUpdate({
      challenges: [...openChallenges, ...finishedChallenges],
      settings: { ...message().settings },
    });
    render(<ChallengeLog now={fixedNow} update={update} />);
    expect(screen.getByText("+35 weitere")).toBeInTheDocument();
    expect(document.querySelectorAll(".challenge-source__row")).toHaveLength(5);
    expect(document.querySelectorAll(".challenge-source__row").length).toBe(5);
  });

  it("verwendet maxVisible als Kapazität in der cut-Quelle", () => {
    const challenges = Array.from({ length: 10 }, (_, index) => challenge(`capacity-${String(index)}`, `Kapazität ${String(index)}`, "pending", index));
    const view = render(<ChallengeLog now={fixedNow} update={sourceUpdate({ challenges, settings: { ...message().settings, maxVisible: 3 } })} />);
    expect(document.querySelectorAll(".challenge-source__row")).toHaveLength(3);
    expect(screen.getByText("+7 weitere")).toBeInTheDocument();

    view.rerender(<ChallengeLog now={fixedNow} update={sourceUpdate({ challenges, settings: { ...message().settings, maxVisible: 8 } })} />);
    expect(document.querySelectorAll(".challenge-source__row")).toHaveLength(8);
    expect(screen.getByText("+2 weitere")).toBeInTheDocument();
  });
});
