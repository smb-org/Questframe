import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

import { deliverRequiredWebSocketMessage, FakeWebSocket, setLocationToken, stubFakeWebSocket } from "../../support/fake-websocket";

import { CompositeApp } from "../../../src/composite/CompositeApp";
import type { BingoStyleLoader } from "../../../src/bingo/style-loader";
import { createDefaultState } from "../../../src/shared/contracts/state";
import type { ChallengeUpdate } from "../../../src/shared/contracts/win-challenges";
import { OVERLAY_SOCKET_PROTOCOL } from "../../../src/shared/contracts/protocol";

const token = "A".repeat(43);

class FakeAudio {
  static instances: FakeAudio[] = [];
  readonly src: string;
  preload = "";
  currentTime = 0;
  readonly play = vi.fn(() => Promise.resolve());
  readonly load = vi.fn();
  readonly pause = vi.fn();

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
}

const state = createDefaultState(
  { twitchUserId: "12345678901234567890", displayName: "Test" },
  "2026-08-31T12:00:00.000Z",
);

const update: ChallengeUpdate = {
  eventSeq: 0,
  boardRevision: 1,
  settingsRevision: 1,
  settings: {
    styleId: "plain-list",
    themeMode: "own",
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
    overflowMode: "cut", overflowTempo: "medium", numbered: false, keyVisible: false, doneOrder: "end", globalTimerMode: "down",
    globalTimer: null,
    placement: { x: 30, y: 8, scale: 1.25 },
  },
  challenges: [{
    id: "challenge-1",
    title: "Komposit sichtbar",
    kind: "counter",
    unit: null,
    controlKey: "K7RP",
    targetCount: 3,
    timerTotalMs: null,
    sortOrder: 0,
    step: 1,
    bestCount: 0,
    hidden: false,
    currentCount: 1,
    state: "pending",
    timerEndsAt: null,
    timerRemainMs: null,
    completedAt: null,
    createdAt: "2026-08-31T12:00:00.000Z",
    updatedAt: "2026-08-31T12:00:00.000Z",
  }],
  event: null,
};

beforeEach(() => {
  stubFakeWebSocket();
  FakeAudio.instances = [];
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  window.sessionStorage.clear();
  window.localStorage.clear();
  setLocationToken("/overlay/all", token);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CompositeApp", () => {
  it("hält HUD und Challenges bei einem Bingo-Chunkfehler am Leben und lädt Bingo still erneut", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const recoveredBingo: ComponentType<{ loadStyle?: BingoStyleLoader; reloadPage?: () => void }> = () => <div>Wiederhergestelltes Bingo</div>;
    const loadBingoSource = vi.fn<() => Promise<{ default: typeof recoveredBingo }>>()
      .mockRejectedValueOnce(new Error("Chunk nicht verfügbar"))
      .mockResolvedValue({ default: recoveredBingo });
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    render(<CompositeApp loadBingoSource={loadBingoSource} loadStyle={() => Promise.resolve()} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await deliverRequiredWebSocketMessage(FakeWebSocket.instances[0], {
      type: "snapshot",
      state: { ...state, compositeHudVisible: true, compositeBingoVisible: true, compositeChallengesVisible: false },
    });

    // Kein sichtbarer Fehler im Stream, nur ein stiller Neuversuch nach 30 Sekunden.
    await waitFor(() => expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 30_000)).toBe(true));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector(".hud-stage")).not.toBeNull();
    const retry = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 30_000)?.[0] as () => void;
    act(() => retry());

    expect(await screen.findByText("Wiederhergestelltes Bingo")).toBeInTheDocument();
    expect(document.querySelector(".hud-stage")).not.toBeNull();
    expect(loadBingoSource).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it("rendert Bingo unabhängig vom Challenges-Schalter an der eigenen Raster-Position", async () => {
    render(<CompositeApp loadBingoStyle={() => Promise.resolve()} loadStyle={() => Promise.resolve()} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;

    await deliverRequiredWebSocketMessage(socket, {
      type: "snapshot",
      state: { ...state, compositeBingoVisible: true, compositeChallengesVisible: false },
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const bingoSocket = FakeWebSocket.instances.find(({ url }) => url.includes("/ws/bingo"));
    expect(bingoSocket).toBeDefined();
    await deliverRequiredWebSocketMessage(bingoSocket, {
      type: "bingo_update",
      board: {
        card: {
          title: "Bingo im Composite",
          size: 3,
          cells: Array.from({ length: 9 }, (_, index) => ({ id: `b${String(index)}`, text: `Feld ${String(index)}` })),
        },
        marks: ["b0", "b4", "b8"],
        cardRevision: 1,
        markRevision: 3,
        generation: 0,
        style: "marker",
        placement: { x: 30, y: 8, scale: 1.25 },
      },
    });

    expect(await screen.findByRole("grid", { name: "Bingo im Composite" })).toBeInTheDocument();
    expect(document.querySelector(".bingo-source-ceremony")).toHaveStyle({ "--bingo-x": "150px", "--bingo-y": "40px" });
    expect(document.querySelector(".challenge-source-ceremony")).not.toBeInTheDocument();
    expect(socket.url).toContain("/ws/composite");
  });

  it("startet bei einer kaputten Bingo-Nachricht nur die Bingo-Quelle neu", async () => {
    const reloadPage = vi.fn();
    render(<CompositeApp loadBingoStyle={() => Promise.resolve()} loadStyle={() => Promise.resolve()} reloadPage={reloadPage} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await deliverRequiredWebSocketMessage(FakeWebSocket.instances[0], {
      type: "snapshot",
      state: { ...state, compositeBingoVisible: true, compositeChallengesVisible: false },
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const bingoSocket = FakeWebSocket.instances.find(({ url }) => url.includes("/ws/bingo"));
    expect(bingoSocket).toBeDefined();

    await deliverRequiredWebSocketMessage(bingoSocket, { type: "bingo_update", board: {} });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));

    expect(reloadPage).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances.filter(({ url }) => url.includes("/ws/composite"))).toHaveLength(1);
  });

  it("rendert Challenge-Updates nach einem kaputten HUD-Snapshot beim Kaltstart", async () => {
    render(<CompositeApp loadStyle={() => Promise.resolve()} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;

    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state: {} });
    await deliverRequiredWebSocketMessage(socket, update);

    await waitFor(() => expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument());
  });

  it("rendert HUD und Challenge-Log an ihren eigenen Placements", async () => {
    render(<CompositeApp loadStyle={() => Promise.resolve()} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toMatch(/\/ws\/composite$/);
    expect(socket?.protocols).toEqual([OVERLAY_SOCKET_PROTOCOL, token]);

    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state: { ...state, placement: { ...state.placement, x: 42, y: 24 } } });
    await deliverRequiredWebSocketMessage(socket, update);

    await waitFor(() => expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument());
    expect(document.querySelector(".hud-root")).toHaveStyle({ "--hud-x": "42px", "--hud-y": "24px" });
    expect(document.querySelector(".challenge-source")).toHaveStyle({ "--wc-x": "150px", "--wc-y": "40px", "--wc-scale": "1.25" });
  });

  it("wendet Mitgliedschaft und overlayEnabled unabhängig auf die Module an", async () => {
    const reloadPage = vi.fn();
    render(<CompositeApp loadStyle={() => Promise.resolve()} reloadPage={reloadPage} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    await deliverRequiredWebSocketMessage(socket, update);
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state: { ...state, compositeHudVisible: false } });

    await waitFor(() => expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument());
    expect(document.querySelector(".hud-stage")).toBeNull();
    expect(reloadPage).not.toHaveBeenCalled();

    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state: { ...state, overlayEnabled: false, compositeHudVisible: true } });
    expect(document.querySelector(".hud-stage")).toBeNull();
    expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument();
  });

  it("unterdrückt bei ausgeblendeten Challenges Zeremonie und Ton, behält aber das aktuelle Bild", async () => {
    render(<CompositeApp loadStyle={() => Promise.resolve()} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state: { ...state, compositeChallengesVisible: false } });
    await deliverRequiredWebSocketMessage(socket, {
      ...update,
      eventSeq: 1,
      event: { scope: "challenge", type: "progressed", challengeId: "challenge-1", delta: 1, previousCount: 1, currentCount: 2 },
    });

    expect(screen.queryByText("Komposit sichtbar")).not.toBeInTheDocument();
    expect(FakeAudio.instances.every((audio) => audio.play.mock.calls.length === 0)).toBe(true);

    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state });
    await waitFor(() => expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument());
    expect(document.querySelector("[data-ceremony-type]")).toBeNull();
  });

  it("stoppt laufende Challenge-Audioausgabe beim Ausblenden", async () => {
    render(<CompositeApp loadStyle={() => Promise.resolve()} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state });
    await deliverRequiredWebSocketMessage(socket, {
      ...update,
      eventSeq: 1,
      event: { scope: "challenge", type: "progressed", challengeId: "challenge-1", delta: 1, previousCount: 1, currentCount: 2 },
    });
    await waitFor(() => expect(document.querySelector("[data-ceremony-type]")).toHaveAttribute("data-ceremony-type", "progressed"));
    const tick = FakeAudio.instances.find((audio) => audio.src.endsWith("/tick.mp3"));
    expect(tick?.play).toHaveBeenCalledTimes(1);

    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state: { ...state, compositeChallengesVisible: false } });
    expect(document.querySelector("[data-ceremony-type]")).toBeNull();
    expect(tick?.pause).toHaveBeenCalledTimes(1);
  });

  it("behält beide Modulbilder während eines Reconnects und ersetzt sie mit dem neuen Snapshot", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    render(<CompositeApp loadStyle={() => Promise.resolve()} />);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const first = FakeWebSocket.instances[0] as FakeWebSocket;
    await deliverRequiredWebSocketMessage(first, { type: "snapshot", state });
    await deliverRequiredWebSocketMessage(first, update);
    await vi.waitFor(() => expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument());

    act(() => { first.emit("close"); });
    expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument();
    expect(document.querySelector(".hud-stage")).not.toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1] as FakeWebSocket;
    await deliverRequiredWebSocketMessage(second, { type: "snapshot", state: { ...state, compositeHudVisible: false } });
    expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument();
    expect(document.querySelector(".hud-stage")).toBeNull();
  });

  it("lädt bei ausschließlich kaputtem Challenge-Paket nach der Watchdog-Frist nicht neu", async () => {
    vi.useFakeTimers();
    const reloadPage = vi.fn();
    render(<CompositeApp loadStyle={() => Promise.resolve()} reloadPage={reloadPage} />);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state });
    await deliverRequiredWebSocketMessage(socket, update);
    await vi.waitFor(() => expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument());

    await deliverRequiredWebSocketMessage(socket, { eventSeq: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(reloadPage).not.toHaveBeenCalled();
    expect(document.querySelector(".hud-stage")).not.toBeNull();
  });

  it("lädt bei ausschließlich kaputtem HUD-Paket nach der Watchdog-Frist nicht neu", async () => {
    vi.useFakeTimers();
    const reloadPage = vi.fn();
    render(<CompositeApp loadStyle={() => Promise.resolve()} reloadPage={reloadPage} />);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state });
    await deliverRequiredWebSocketMessage(socket, update);
    await vi.waitFor(() => expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument());

    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state: {} });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(reloadPage).not.toHaveBeenCalled();
    expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument();
  });

  it("lädt genau einmal neu, wenn beide Composite-Module kaputt sind", async () => {
    vi.useFakeTimers();
    const reloadPage = vi.fn();
    render(<CompositeApp loadStyle={() => Promise.resolve()} reloadPage={reloadPage} />);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state });
    await deliverRequiredWebSocketMessage(socket, update);
    await vi.waitFor(() => expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument());

    await deliverRequiredWebSocketMessage(socket, { eventSeq: 1 });
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state: {} });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument();
  });

  it("lädt allein neu, wenn nur das HUD dauerhaft kaputt ist (Challenges parsen weiter)", async () => {
    vi.useFakeTimers();
    const reloadPage = vi.fn();
    render(<CompositeApp loadStyle={() => Promise.resolve()} reloadPage={reloadPage} />);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state });
    await deliverRequiredWebSocketMessage(socket, update);
    await vi.waitFor(() => expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument());

    // HUD bleibt dauerhaft kaputt, Challenges parsen währenddessen weiter.
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state: {} });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await deliverRequiredWebSocketMessage(socket, { ...update, eventSeq: 1 });
    expect(reloadPage).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it("reloadet nicht, wenn ein einzelner Fehlschlag von einer gültigen Nachricht desselben Moduls gefolgt wird", async () => {
    vi.useFakeTimers();
    const reloadPage = vi.fn();
    render(<CompositeApp loadStyle={() => Promise.resolve()} reloadPage={reloadPage} />);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state });
    await deliverRequiredWebSocketMessage(socket, update);
    await vi.waitFor(() => expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument());

    // Einzelner Fehlschlag des HUD, danach erholt es sich sofort wieder.
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state: {} });
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it("löscht den Watchdog-Marker erst nach der Erholung beider Module", async () => {
    vi.useFakeTimers();
    const reloadPage = vi.fn();
    render(<CompositeApp loadStyle={() => Promise.resolve()} reloadPage={reloadPage} />);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;

    await deliverRequiredWebSocketMessage(socket, { eventSeq: 1 });
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state: {} });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem("irl-stream-hud:composite-watchdog-reload-at")).not.toBeNull();

    await deliverRequiredWebSocketMessage(socket, update);
    expect(window.sessionStorage.getItem("irl-stream-hud:composite-watchdog-reload-at")).not.toBeNull();

    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state });
    expect(window.sessionStorage.getItem("irl-stream-hud:composite-watchdog-reload-at")).toBeNull();
  });

  it("rearmiert den Watchdog nach erfolgreich geparsten Nachrichten beider Module", async () => {
    vi.useFakeTimers();
    const reloadPage = vi.fn();
    render(<CompositeApp loadStyle={() => Promise.resolve()} reloadPage={reloadPage} />);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state });
    await deliverRequiredWebSocketMessage(socket, update);
    await vi.waitFor(() => expect(screen.getByText("Komposit sichtbar")).toBeInTheDocument());

    await deliverRequiredWebSocketMessage(socket, { eventSeq: 1 });
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state: {} });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(reloadPage).toHaveBeenCalledTimes(1);

    await deliverRequiredWebSocketMessage(socket, update);
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state });
    await deliverRequiredWebSocketMessage(socket, { eventSeq: 2 });
    await deliverRequiredWebSocketMessage(socket, { type: "snapshot", state: {} });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(reloadPage).toHaveBeenCalledTimes(2);
  });
});
