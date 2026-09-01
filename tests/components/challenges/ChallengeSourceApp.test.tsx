import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChallengeSourceApp } from "../../../src/challenges/ChallengeSourceApp";
import { ChallengeLog } from "../../../src/modules/win-challenges/ui/ChallengeLog";
import type { ChallengeStyleId, ChallengeThemeId, ChallengeUpdate } from "../../../src/shared/contracts/win-challenges";
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
  targetCount: state === "done" ? 1 : 10,
  timerTotalMs: null,
  sortOrder,
  hidden: false,
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
    overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end",
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
    await deliver(socket, sourceUpdate({ eventSeq: 2, settings, event: { ...progressed, previousCount: 4, currentCount: 5 } }));

    expect(document.querySelector(".challenge-source-ceremony")).not.toBe(firstCeremony);
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

  it.each(styleNames)("rendert dieselben Daten lesbar im %s-Style für surface und bare", (styleId) => {
    const visibleDone = { ...challenge("done", "Erledigt unten", "done", 0), completedAt: new Date(fixedNow).toISOString() };
    const visibleUpdate = sourceUpdate({
      challenges: [visibleDone, challenge("open", "Offene Challenge", "pending", 1)],
    });
    for (const surfaceMode of ["surface", "bare"] as const) {
      const view = render(<ChallengeLog now={fixedNow} update={{
        ...visibleUpdate,
        settings: { ...visibleUpdate.settings, styleId, surfaceMode, themeMode: "own" },
      }} />);

      const source = document.querySelector(".challenge-source");
      expect(source).toHaveAttribute("data-style", styleId);
      expect(source).toHaveAttribute("data-surface-mode", surfaceMode);
      expect(screen.getByText("Offene Challenge")).toBeInTheDocument();
      expect(screen.getByText("Erledigt unten")).toBeInTheDocument();
      const rows = [...document.querySelectorAll(".challenge-source__row")];
      expect(rows.at(-1)).toHaveAttribute("data-state", "done");
      expect(rows.at(-1)?.querySelector(".challenge-source__mark")).toHaveTextContent("✓");

      view.unmount();
    }
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

  it("zeigt die Nummer in der Markierungsspalte und ersetzt Häkchen sowie Quest-Raute", () => {
    const done = { ...challenge("done-number", "Erledigt nummeriert", "done", 1), completedAt: new Date(fixedNow).toISOString() };
    const update = sourceUpdate({
      challenges: [challenge("open-number", "Offen nummeriert", "pending", 0), done],
      settings: { ...message().settings, numbered: true },
    });
    const view = render(<ChallengeLog now={fixedNow} update={update} />);
    const openMark = document.querySelector('[data-challenge-id="open-number"] .challenge-source__mark');
    const doneMark = document.querySelector('[data-challenge-id="done-number"] .challenge-source__mark');
    expect(openMark).toHaveTextContent("1");
    expect(doneMark).toHaveTextContent("2");
    expect(doneMark).not.toHaveTextContent("✓");

    view.rerender(<ChallengeLog now={fixedNow} update={sourceUpdate({
      challenges: [challenge("quest-number", "Quest nummeriert", "pending", 0)],
      settings: { ...message().settings, styleId: "quest-log", numbered: true },
    })} />);
    expect(document.querySelector(".challenge-source__mark")).toHaveTextContent("1");
    expect(document.querySelector(".challenge-source__mark")).not.toHaveTextContent("◆");
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
