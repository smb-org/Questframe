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
    style: "marker",
    placement: { x: 0, y: 0, scale: 1 },
  },
};

const PresentationStatus = ({ loadStyle }: { loadStyle: BingoStyleLoader }) => {
  const presentation = useBingoPresentation({ update, loadStyle });
  return <output data-testid="ready">{String(presentation.ready)}</output>;
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
});
