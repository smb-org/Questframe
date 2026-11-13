import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useBingoPresentation } from "../../../src/bingo/useBingoPresentation";
import type { BingoUpdateMessage } from "../../../src/modules/bingo/contracts/schemas";
import type { BingoStyleLoader } from "../../../src/bingo/style-loader";

const update: BingoUpdateMessage = {
  type: "bingo_update",
  board: {
    card: {
      title: "Testkarte",
      size: 3,
      cells: Array.from({ length: 9 }, (_, index) => ({ id: `cell-${String(index)}`, text: `Feld ${String(index + 1)}` })),
    },
    marks: [],
    cardRevision: 1,
    markRevision: 0,
    generation: 0,
    settingsRevision: 1,
    settings: {
      backgroundOpacity: 100, textScale: 1, fontFamily: "theme", textEmphasis: "auto",
      ceremonyMode: "on", soundOnLine: false, soundOnFullCard: false, showTitle: true, showBingo: true,
    },
    style: "marker",
    placement: { x: 0, y: 0, scale: 1 },
  },
};

const PresentationStatus = ({ loadStyle }: { loadStyle: BingoStyleLoader }) => {
  const presentation = useBingoPresentation({ update, loadStyle });
  return <output data-testid="ready">{String(presentation.ready)}</output>;
};

const PresentationHarness = ({
  nextUpdate,
  loadStyle,
  createAudio,
}: {
  nextUpdate: BingoUpdateMessage;
  loadStyle: BingoStyleLoader;
  createAudio: (source: string) => HTMLAudioElement;
}) => {
  const presentation = useBingoPresentation({ update: nextUpdate, loadStyle, createAudio });
  return <><output data-testid="ceremony">{presentation.activeCeremony?.type ?? "none"}</output><button onClick={() => presentation.acceptUpdate(nextUpdate)} type="button">Update annehmen</button></>;
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Bingo-Stil-Laden", () => {
  it("lädt nach einem fehlgeschlagenen Stilaufruf erneut und wird mit unverändertem Update bereit", async () => {
    vi.useFakeTimers();
    const loadStyle = vi.fn<BingoStyleLoader>()
      .mockRejectedValueOnce(new Error("Verbindung unterbrochen"))
      .mockResolvedValue(undefined);
    render(<PresentationStatus loadStyle={loadStyle} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadStyle).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("ready")).toHaveTextContent("false");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
    });

    expect(loadStyle).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("ready")).toHaveTextContent("true");
  });

  it("versucht nach mehreren Chunk-Fehlern mit wachsendem, begrenztem Intervall weiter", async () => {
    vi.useFakeTimers();
    const loadStyle = vi.fn<BingoStyleLoader>()
      .mockRejectedValueOnce(new Error("Verbindung unterbrochen"))
      .mockRejectedValueOnce(new Error("Verbindung unterbrochen"))
      .mockRejectedValueOnce(new Error("Verbindung unterbrochen"))
      .mockResolvedValue(undefined);
    render(<PresentationStatus loadStyle={loadStyle} />);

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(loadStyle).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("ready")).toHaveTextContent("false");

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(loadStyle).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("ready")).toHaveTextContent("false");

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(loadStyle).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("ready")).toHaveTextContent("false");

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(loadStyle).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId("ready")).toHaveTextContent("true");
  });

  it("spielt den Linienton nur aus einem Zeremonie-Payload und respektiert Zeremonie aus", async () => {
    const linePlay = vi.fn();
    const createAudio = (source: string): HTMLAudioElement => {
      const audio = { load: vi.fn(), play: vi.fn(() => { if (source === "/assets/sounds/complete.mp3") linePlay(); return Promise.resolve(); }), pause: vi.fn(), currentTime: 0, preload: "" };
      return audio as unknown as HTMLAudioElement;
    };
    const loadStyle = vi.fn<BingoStyleLoader>(() => Promise.resolve());
    const payloadUpdate: BingoUpdateMessage = {
      ...update,
      board: { ...update.board, markRevision: 2, settings: { ...update.board.settings, soundOnLine: true } },
      ceremony: { lines: [{ kind: "row", index: 0 }], fullCard: false },
    };
    const { unmount } = render(<PresentationHarness nextUpdate={{ ...update, board: { ...update.board, markRevision: 1, settings: { ...update.board.settings, soundOnLine: true } } }} loadStyle={loadStyle} createAudio={createAudio} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => { screen.getByRole("button", { name: "Update annehmen" }).click(); });
    expect(screen.getByTestId("ceremony")).toHaveTextContent("none");
    expect(linePlay).not.toHaveBeenCalled();
    unmount();

    const { unmount: unmountWithPayload } = render(<PresentationHarness nextUpdate={payloadUpdate} loadStyle={loadStyle} createAudio={createAudio} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => { screen.getByRole("button", { name: "Update annehmen" }).click(); });
    expect(screen.getByTestId("ceremony")).toHaveTextContent("line");
    expect(linePlay).toHaveBeenCalledOnce();
    unmountWithPayload();

    const turnedOff: BingoUpdateMessage = {
      ...payloadUpdate,
      board: { ...payloadUpdate.board, markRevision: 3, settings: { ...payloadUpdate.board.settings, ceremonyMode: "off", soundOnLine: true } },
    };
    render(<PresentationHarness nextUpdate={turnedOff} loadStyle={loadStyle} createAudio={createAudio} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => { screen.getByRole("button", { name: "Update annehmen" }).click(); });
    expect(screen.getByTestId("ceremony")).toHaveTextContent("none");
    expect(linePlay).toHaveBeenCalledOnce();
  });
});
