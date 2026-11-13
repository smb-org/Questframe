import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BingoAdminPanel, type BingoAdminApi, type BingoAdminSaveHandle } from "../../../src/modules/bingo/ui/BingoAdminPanel";
import type {
  BingoBoardState,
  BingoCardSaveRequest,
  BingoMutationResponse,
  BingoSettingsSaveRequest,
  BingoSetResponse,
  BingoSetSummary,
  BingoStyleId,
  BingoUndoResponse,
  BingoUpdateMessage,
  MarkCellPayload,
} from "../../../src/modules/bingo/contracts/schemas";
import type { BingoUndoBaseRevisions } from "../../../src/shared/contracts/api";
import type { ChallengePlacement } from "../../../src/shared/contracts/win-challenges";

const createBoard = (): BingoBoardState => ({
  card: {
    title: "Testkarte",
    size: 3,
    cells: Array.from({ length: 9 }, (_, index) => ({ id: `cell-${String(index)}`, text: `Ereignis ${String(index)}` })),
  },
  marks: [],
  cardRevision: 7,
  markRevision: 4,
  generation: 2,
  settingsRevision: 1,
  settings: {
    backgroundOpacity: 100, textScale: 1, fontFamily: "theme", textEmphasis: "auto",
    ceremonyMode: "on", soundOnLine: false, soundOnFullCard: false, showTitle: true, showBingo: true,
  },
  style: "marker",
  placement: { x: 12, y: 8, scale: 1 },
});

const update = (board: BingoBoardState, ceremony?: BingoUpdateMessage["ceremony"]): BingoUpdateMessage => ({
  type: "bingo_update",
  board,
  ...(ceremony === undefined ? {} : { ceremony }),
});

const mutation = (board: BingoBoardState) => ({
  board,
  update: update(board),
  ceremony: null,
  auditEntry: null,
  undoTargets: [],
  serverTime: "2026-11-12T12:00:00.000Z",
});

const createApi = (overrides: Partial<BingoAdminApi> = {}) => ({
  getBingoBoard: vi.fn(() => Promise.resolve(createBoard())),
  markBingoCell: vi.fn((request: MarkCellPayload) => { void request; return Promise.resolve(mutation({ ...createBoard(), marks: ["cell-0"], markRevision: 5 })); }),
  resetBingoMarks: vi.fn((expectedMarkRevision: number) => { void expectedMarkRevision; return Promise.resolve(mutation({ ...createBoard(), markRevision: 5 })); }),
  saveBingoCard: vi.fn((request: BingoCardSaveRequest) => { void request; return Promise.resolve(mutation(createBoard())); }),
  saveBingoSettings: vi.fn((request: BingoSettingsSaveRequest) => Promise.resolve(mutation({ ...createBoard(), settings: request.settings, settingsRevision: createBoard().settingsRevision + 1 }))),
  listBingoSets: vi.fn(() => Promise.resolve({ sets: [] })),
  getBingoSet: vi.fn((setId: string) => { void setId; return Promise.resolve({ summary: { id: "set-1", type: "template" as const, name: "Vorlage", sortOrder: 0, createdAt: "2026-11-12T12:00:00.000Z", updatedAt: "2026-11-12T12:00:00.000Z" }, card: createBoard().card } satisfies BingoSetResponse); }),
  saveBingoSet: vi.fn((name: string) => { void name; return Promise.resolve({ summary: { id: "set-1", type: "user" as const, name: "Mein Set", sortOrder: 0, createdAt: "2026-11-12T12:00:00.000Z", updatedAt: "2026-11-12T12:00:00.000Z" }, card: createBoard().card } satisfies BingoSetResponse); }),
  renameBingoSet: vi.fn((setId: string, name: string) => Promise.resolve({ summary: { id: setId, type: "template" as const, name, sortOrder: 0, createdAt: "2026-11-12T12:00:00.000Z", updatedAt: "2026-11-13T12:00:00.000Z" }, card: createBoard().card } satisfies BingoSetResponse)),
  deleteBingoSet: vi.fn((id: string) => Promise.resolve(id)),
  loadBingoSet: vi.fn((setId: string, revision: number) => { void setId; void revision; return Promise.resolve(mutation(createBoard())); }),
  importBingoCard: vi.fn((file: string, revision: number) => { void file; void revision; return Promise.resolve(mutation(createBoard())); }),
  exportBingoCard: vi.fn(() => Promise.resolve(JSON.stringify({ format: "questframe-bingo", version: 1, card: createBoard().card }))),
  setBingoStyle: vi.fn((style: BingoStyleId, expectedCardRevision: number) => {
    void expectedCardRevision;
    return Promise.resolve(mutation({ ...createBoard(), style, cardRevision: 8 }));
  }),
  undo: vi.fn((moduleId: "bingo", channelSeq: number, baseRevision: BingoUndoBaseRevisions) => { void moduleId; void channelSeq; void baseRevision; return Promise.resolve({ board: createBoard(), undoTargets: [], serverTime: "2026-11-12T12:00:00.000Z" } satisfies BingoUndoResponse); }),
  ...overrides,
});

const renderPanel = (api = createApi()) => render(
  <BingoAdminPanel
    api={api}
    canUndo
    initialUndoTargets={[]}
    onBoardUpdate={vi.fn()}
    onUndoTargetsChange={vi.fn()}
    online
    update={null}
  />,
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Bingo-Regie und Editor", () => {
  it("behält einen Titelentwurf, wenn nach einem Socket-Snapshot der initiale GET mit neueren Kreuzen eintrifft", async () => {
    const user = userEvent.setup();
    let resolveInitial: ((board: BingoBoardState) => void) | undefined;
    const api = createApi({
      getBingoBoard: vi.fn(() => new Promise<BingoBoardState>((resolve) => { resolveInitial = resolve; })),
    });
    const props = {
      api,
      canUndo: true,
      initialUndoTargets: [],
      onBoardUpdate: vi.fn(),
      onUndoTargetsChange: vi.fn(),
      online: true,
    };
    const { rerender } = render(<BingoAdminPanel {...props} update={null} />);
    const snapshot = { ...createBoard(), marks: ["cell-0"], markRevision: 5 };
    rerender(<BingoAdminPanel {...props} update={update(snapshot)} />);

    await screen.findByRole("grid", { name: "Testkarte" });
    await user.clear(screen.getByRole("textbox", { name: "Kartentitel" }));
    await user.type(screen.getByRole("textbox", { name: "Kartentitel" }), "Mein Entwurf");

    await act(async () => {
      resolveInitial?.({ ...snapshot, marks: ["cell-1"], markRevision: 6 });
      await Promise.resolve();
    });

    expect(screen.getByRole("textbox", { name: "Kartentitel" })).toHaveValue("Mein Entwurf");
    expect(screen.getByRole("gridcell", { name: "Ereignis 1, angekreuzt" })).toHaveAttribute("data-marked", "true");
  });

  it("übernimmt eine geladene Karte trotz zwischenzeitlich neuerer Socket-Kreuze und behält diese Kreuze", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let resolveLoad: ((result: BingoMutationResponse) => void) | undefined;
    const timestamp = "2026-11-12T12:00:00.000Z";
    const api = createApi({
      listBingoSets: vi.fn(() => Promise.resolve({ sets: [{
        id: "template-1",
        type: "template" as const,
        name: "Vorlage",
        sortOrder: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }] })),
      loadBingoSet: vi.fn(() => new Promise<BingoMutationResponse>((resolve) => { resolveLoad = resolve; })),
    });
    const props = {
      api,
      canUndo: true,
      initialUndoTargets: [],
      onBoardUpdate: vi.fn(),
      onUndoTargetsChange: vi.fn(),
      online: true,
    };
    const { rerender } = render(<BingoAdminPanel {...props} update={null} />);
    await screen.findByRole("grid", { name: "Testkarte" });
    await user.clear(screen.getByRole("textbox", { name: "Kartentitel" }));
    await user.type(screen.getByRole("textbox", { name: "Kartentitel" }), "Mein Entwurf");
    await user.selectOptions(screen.getByRole("combobox", { name: "Vorlage oder gespeichertes Set" }), "template-1");
    expect(confirm).toHaveBeenCalledWith("Den ungespeicherten Entwurf durch dieses Set ersetzen?");
    await waitFor(() => expect(api.loadBingoSet).toHaveBeenCalledWith("template-1", 7));

    const socketBoard = {
      ...createBoard(),
      card: { ...createBoard().card, title: "Andere Serverkarte" },
      marks: ["cell-8"],
      cardRevision: 8,
      markRevision: 5,
    };
    rerender(<BingoAdminPanel {...props} update={update(socketBoard)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("parallel geändert");

    await act(async () => {
      resolveLoad?.(mutation({
        ...createBoard(),
        card: { ...createBoard().card, title: "Geladene Vorlage" },
        cardRevision: 8,
        markRevision: 4,
      }));
      await Promise.resolve();
    });

    expect(screen.getByRole("textbox", { name: "Kartentitel" })).toHaveValue("Geladene Vorlage");
    expect(screen.getByRole("button", { name: "Karte speichern" })).toBeEnabled();
    expect(screen.getByRole("gridcell", { name: "Ereignis 8, angekreuzt" })).toHaveAttribute("data-marked", "true");
  });

  it("blockiert Stilwechsel bei einem ungespeicherten Kartenentwurf und erklärt den Grund im Nachrichtenfeld", async () => {
    const user = userEvent.setup();
    const api = createApi();
    renderPanel(api);

    await screen.findByRole("grid", { name: "Testkarte" });
    await user.clear(screen.getByRole("textbox", { name: "Kartentitel" }));
    await user.type(screen.getByRole("textbox", { name: "Kartentitel" }), "Mein Entwurf");

    expect(screen.getByRole("combobox", { name: "Bingo-Stil" })).toBeDisabled();
    expect(document.querySelector(".bingo-admin-message-slot")).toHaveTextContent("Stil erst nach dem Speichern des Kartenentwurfs ändern.");
    expect(screen.getByRole("textbox", { name: "Kartentitel" })).toHaveValue("Mein Entwurf");
    expect(api.setBingoStyle).not.toHaveBeenCalled();
  });

  it("überschreibt einen neueren Socket-Stand nicht mit einem verspäteten älteren Konflikt-Snapshot", async () => {
    const user = userEvent.setup();
    let rejectMark: ((reason: unknown) => void) | undefined;
    const markBingoCell = vi.fn(() => new Promise<BingoMutationResponse>((_resolve, reject) => { rejectMark = reject; }));
    const api = createApi({ markBingoCell });
    const props = {
      api,
      canUndo: true,
      initialUndoTargets: [],
      onBoardUpdate: vi.fn(),
      onUndoTargetsChange: vi.fn(),
      online: true,
    };
    const { rerender } = render(<BingoAdminPanel {...props} update={null} />);
    await screen.findByRole("grid", { name: "Testkarte" });
    await user.click(screen.getByRole("gridcell", { name: "Ereignis 0" }));

    const newerBoard = { ...createBoard(), marks: ["cell-8"], markRevision: 6 };
    rerender(<BingoAdminPanel {...props} update={update(newerBoard)} />);
    expect(await screen.findByRole("gridcell", { name: "Ereignis 8, angekreuzt" })).toHaveAttribute("data-marked", "true");
    const conflict = Object.assign(new Error("Bingo wurde parallel geändert."), {
      code: "revision_conflict",
      currentSnapshot: { ...createBoard(), marks: ["cell-0"], markRevision: 5 },
    });
    await act(async () => {
      rejectMark?.(conflict);
      await Promise.resolve();
    });

    expect(screen.getByRole("gridcell", { name: "Ereignis 8, angekreuzt" })).toHaveAttribute("data-marked", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Bingo wurde parallel geändert.");
  });

  it("ergänzt eine importierte Karte beim Vergrößern nur um bisher unbenutzte Feld-IDs", async () => {
    const user = userEvent.setup();
    const importedBoard = {
      ...createBoard(),
      card: {
        ...createBoard().card,
        cells: Array.from({ length: 9 }, (_, index) => ({
          id: index === 0 ? "cell-9" : `cell-${String(index)}`,
          text: `Importfeld ${String(index + 1)}`,
        })),
      },
    };
    const api = createApi({ importBingoCard: vi.fn(() => Promise.resolve(mutation(importedBoard))) });
    renderPanel(api);
    await screen.findByRole("grid", { name: "Testkarte" });
    const fileText = JSON.stringify({ format: "questframe-bingo", version: 1, card: importedBoard.card });
    const file = new File([fileText], "karte.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve(fileText) });
    await user.upload(screen.getByLabelText("Bingo-Karte importieren"), file);

    await user.selectOptions(await screen.findByRole("combobox", { name: "Kartengröße" }), "4");
    await user.click(screen.getByRole("button", { name: "Karte speichern" }));

    await waitFor(() => expect(api.saveBingoCard).toHaveBeenCalledOnce());
    const savedCells = vi.mocked(api.saveBingoCard).mock.calls[0]?.[0].cells;
    expect(savedCells).toHaveLength(16);
    expect(new Set(savedCells?.map(({ id }) => id)).size).toBe(16);
    expect(savedCells?.[0]?.id).toBe("cell-9");
    expect(api.importBingoCard).toHaveBeenCalledOnce();
  });

  it("sendet beim Anklicken den Zielzustand und die aktuelle Markierungsrevision", async () => {
    const user = userEvent.setup();
    const api = createApi();
    renderPanel(api);

    await user.click(await screen.findByRole("gridcell", { name: "Ereignis 0" }));

    expect(api.markBingoCell).toHaveBeenCalledWith({
      cellId: "cell-0",
      marked: true,
      expectedMarkRevision: 4,
    });
    expect(await screen.findByRole("gridcell", { name: "Ereignis 0, angekreuzt" })).toHaveAttribute("data-marked", "true");
  });

  it("sendet drei schnelle Markierungen nacheinander mit den jeweils neuesten Revisionen", async () => {
    const user = userEvent.setup();
    const resolvers: Array<(result: BingoMutationResponse) => void> = [];
    const api = createApi({
      markBingoCell: vi.fn(() => new Promise<BingoMutationResponse>((resolve) => { resolvers.push(resolve); })),
    });
    renderPanel(api);

    await user.click(await screen.findByRole("gridcell", { name: "Ereignis 0" }));
    await user.click(screen.getByRole("gridcell", { name: "Ereignis 4" }));
    await user.click(screen.getByRole("gridcell", { name: "Ereignis 8" }));

    act(() => {
      resolvers[0]?.(mutation({ ...createBoard(), marks: ["cell-0"], markRevision: 5 }));
    });
    await waitFor(() => expect(api.markBingoCell).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.markBingoCell).mock.calls.map(([request]) => request.expectedMarkRevision)).toEqual([4, 5]);

    act(() => {
      resolvers[1]?.(mutation({ ...createBoard(), marks: ["cell-0", "cell-4"], markRevision: 6 }));
    });
    await waitFor(() => expect(api.markBingoCell).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.markBingoCell).mock.calls.map(([request]) => request.expectedMarkRevision)).toEqual([4, 5, 6]);

    act(() => {
      resolvers[2]?.(mutation({ ...createBoard(), marks: ["cell-0", "cell-4", "cell-8"], markRevision: 7 }));
    });

    expect(await screen.findByRole("gridcell", { name: "Ereignis 0, angekreuzt" })).toHaveAttribute("data-marked", "true");
    expect(screen.getByRole("gridcell", { name: "Ereignis 4, angekreuzt" })).toHaveAttribute("data-marked", "true");
    expect(screen.getByRole("gridcell", { name: "Ereignis 8, angekreuzt" })).toHaveAttribute("data-marked", "true");
  });

  it("wiederholt eine wartende Markierung nach einem Revisionskonflikt mit der frischen Revision", async () => {
    const user = userEvent.setup();
    const resolvers: Array<(result: BingoMutationResponse) => void> = [];
    const rejectSecond: Array<(reason: unknown) => void> = [];
    const api = createApi({
      markBingoCell: vi.fn((request: MarkCellPayload) => {
        void request;
        return new Promise<BingoMutationResponse>((resolve, reject) => {
          resolvers.push(resolve);
          rejectSecond.push(reject);
        });
      }),
    });
    renderPanel(api);

    await user.click(await screen.findByRole("gridcell", { name: "Ereignis 0" }));
    await user.click(screen.getByRole("gridcell", { name: "Ereignis 1" }));
    act(() => {
      resolvers[0]?.(mutation({ ...createBoard(), marks: ["cell-0"], markRevision: 5 }));
    });
    await waitFor(() => expect(api.markBingoCell).toHaveBeenCalledTimes(2));

    const conflictBoard = { ...createBoard(), marks: ["cell-0", "cell-8"], markRevision: 6 };
    act(() => {
      rejectSecond[1]?.(Object.assign(new Error("Bingo wurde parallel geändert."), {
        code: "revision_conflict",
        currentSnapshot: conflictBoard,
      }));
    });
    await waitFor(() => expect(api.markBingoCell).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.markBingoCell).mock.calls.map(([request]) => request.expectedMarkRevision)).toEqual([4, 5, 6]);

    act(() => {
      resolvers[2]?.(mutation({ ...conflictBoard, marks: [...conflictBoard.marks, "cell-1"], markRevision: 7 }));
    });
    expect(await screen.findByRole("gridcell", { name: "Ereignis 1, angekreuzt" })).toHaveAttribute("data-marked", "true");
  });

  it("verwirft einen Markierungskonflikt lautlos, wenn das Feld inzwischen den Zielzustand hat", async () => {
    const user = userEvent.setup();
    const resolvers: Array<(result: BingoMutationResponse) => void> = [];
    const rejecters: Array<(reason: unknown) => void> = [];
    const api = createApi({
      markBingoCell: vi.fn(() => new Promise<BingoMutationResponse>((resolve, reject) => {
        resolvers.push(resolve);
        rejecters.push(reject);
      })),
    });
    renderPanel(api);

    await user.click(await screen.findByRole("gridcell", { name: "Ereignis 0" }));
    await user.click(screen.getByRole("gridcell", { name: "Ereignis 1" }));
    act(() => {
      resolvers[0]?.(mutation({ ...createBoard(), marks: ["cell-0"], markRevision: 5 }));
    });
    await waitFor(() => expect(api.markBingoCell).toHaveBeenCalledTimes(2));

    act(() => {
      rejecters[1]?.(Object.assign(new Error("Bingo wurde parallel geändert."), {
        code: "revision_conflict",
        currentSnapshot: { ...createBoard(), marks: ["cell-0", "cell-1"], markRevision: 6 },
      }));
    });

    expect(api.markBingoCell).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("gridcell", { name: "Ereignis 1, angekreuzt" })).toHaveAttribute("data-marked", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("verwirft wartende Markierungen beim Zurücksetzen der Kreuze", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let resolveFirst: ((result: BingoMutationResponse) => void) | undefined;
    const api = createApi({
      markBingoCell: vi.fn(() => new Promise<BingoMutationResponse>((resolve) => { resolveFirst = resolve; })),
      resetBingoMarks: vi.fn((revision: number) => Promise.resolve(mutation({ ...createBoard(), markRevision: revision + 1 }))),
    });
    renderPanel(api);

    await user.click(await screen.findByRole("gridcell", { name: "Ereignis 0" }));
    await user.click(screen.getByRole("gridcell", { name: "Ereignis 1" }));
    await user.click(screen.getByRole("button", { name: "Kreuze zurücksetzen" }));

    expect(confirm).toHaveBeenCalledWith("Alle Bingo-Kreuze zurücksetzen?");
    act(() => {
      resolveFirst?.(mutation({ ...createBoard(), marks: ["cell-0"], markRevision: 5 }));
    });
    await waitFor(() => expect(api.resetBingoMarks).toHaveBeenCalledWith(5));

    expect(api.markBingoCell).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("gridcell", { name: "Ereignis 0" })).toHaveAttribute("data-marked", "false");
    expect(screen.getByRole("gridcell", { name: "Ereignis 1" })).toHaveAttribute("data-marked", "false");
  });

  it("zeigt einen Markierungskonflikt im reservierten Nachrichtenfeld", async () => {
    const user = userEvent.setup();
    const api = createApi({ markBingoCell: vi.fn((request: MarkCellPayload) => { void request; return Promise.reject(new Error("Jemand anderes hat Bingo verändert.")); }) });
    renderPanel(api);

    await user.click(await screen.findByRole("gridcell", { name: "Ereignis 0" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Jemand anderes hat Bingo verändert.");
    expect(alert.closest(".bingo-admin-message-slot")).toBeInTheDocument();
  });

  it("behält bei einer parallelen Kartenänderung die Revision des Entwurfs und bietet den Serverstand an", async () => {
    const user = userEvent.setup();
    const api = createApi();
    const props = {
      api,
      canUndo: true,
      initialUndoTargets: [],
      onBoardUpdate: vi.fn(),
      onUndoTargetsChange: vi.fn(),
      online: true,
    };
    const { rerender } = render(<BingoAdminPanel {...props} update={null} />);
    await screen.findByRole("grid", { name: "Testkarte" });
    await user.clear(screen.getByRole("textbox", { name: "Kartentitel" }));
    await user.type(screen.getByRole("textbox", { name: "Kartentitel" }), "Mein Entwurf");

    const remoteBoard = { ...createBoard(), card: { ...createBoard().card, title: "Neue Serverkarte" }, cardRevision: 8, markRevision: 5 };
    rerender(<BingoAdminPanel {...props} update={update(remoteBoard)} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("parallel geändert");
    expect(alert.closest(".bingo-admin-message-slot")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Karte speichern" })).toBeDisabled();
    await user.click(screen.getByRole("gridcell", { name: "Ereignis 1" }));
    expect(screen.getByRole("alert")).toHaveTextContent("parallel geändert");
    expect(screen.getByRole("button", { name: "Aktuelle Karte übernehmen" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Aktuelle Karte übernehmen" }));

    expect(screen.getByRole("textbox", { name: "Kartentitel" })).toHaveValue("Neue Serverkarte");
    expect(screen.getByRole("button", { name: "Karte speichern" })).toBeEnabled();
  });

  it("übernimmt den direkten Serverstand aus einer Revisionskonflikt-Antwort", async () => {
    const user = userEvent.setup();
    const remoteBoard = { ...createBoard(), card: { ...createBoard().card, title: "Serverstand" }, cardRevision: 8 };
    const conflict = Object.assign(new Error("Revision conflict"), {
      code: "revision_conflict",
      currentSnapshot: remoteBoard,
    });
    const api = createApi({ saveBingoCard: vi.fn(() => Promise.reject(conflict)) });
    renderPanel(api);

    await screen.findByRole("grid", { name: "Testkarte" });
    await user.clear(screen.getByRole("textbox", { name: "Kartentitel" }));
    await user.type(screen.getByRole("textbox", { name: "Kartentitel" }), "Mein Entwurf");
    await user.click(screen.getByRole("button", { name: "Karte speichern" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Revision conflict");
    await user.click(screen.getByRole("button", { name: "Aktuelle Karte übernehmen" }));
    expect(screen.getByRole("textbox", { name: "Kartentitel" })).toHaveValue("Serverstand");
  });

  it("speichert Titel, Größe, Felder und Platzierung über der Feldliste", async () => {
    const user = userEvent.setup();
    const api = createApi();
    const { container } = renderPanel(api);
    await screen.findByRole("grid", { name: "Testkarte" });

    await user.clear(screen.getByRole("textbox", { name: "Kartentitel" }));
    await user.type(screen.getByRole("textbox", { name: "Kartentitel" }), "Crashout");
    fireEvent.change(screen.getByRole("combobox", { name: "Kartengröße" }), { target: { value: "3" } });
    await user.clear(screen.getByRole("textbox", { name: "Feld 1" }));
    await user.type(screen.getByRole("textbox", { name: "Feld 1" }), "Kein Mana");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Platzierung X" }), { target: { value: "20" } });
    await user.click(screen.getByRole("button", { name: "Karte speichern" }));

    await waitFor(() => expect(api.saveBingoCard).toHaveBeenCalledOnce());
    const savedRequest = vi.mocked(api.saveBingoCard).mock.calls[0]?.[0];
    expect(savedRequest).toMatchObject({
      title: "Crashout",
      size: 3,
      placement: { x: 20, y: 8, scale: 1 },
      expectedCardRevision: 7,
    });
    expect(savedRequest?.cells[0]).toEqual({ id: "cell-0", text: "Kein Mana" });
    const save = screen.getByRole("button", { name: "Karte speichern" });
    const list = container.querySelector(".bingo-admin-editor-grid");
    expect(list).not.toBeNull();
    expect(save.compareDocumentPosition(list as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("behält eine nach dem Absenden gezogene Platzierung und rebased sie auf die Rückgabe-Revision", async () => {
    const user = userEvent.setup();
    let resolveFirstSave: ((response: BingoMutationResponse) => void) | undefined;
    let saveCount = 0;
    const api = createApi({
      saveBingoCard: vi.fn((request: BingoCardSaveRequest) => {
        saveCount += 1;
        if (saveCount === 1) return new Promise<BingoMutationResponse>((resolve) => { resolveFirstSave = resolve; });
        return Promise.resolve(mutation({
          ...createBoard(),
          card: { title: request.title, size: request.size, cells: request.cells },
          cardRevision: 9,
          placement: request.placement,
        }));
      }),
    });
    let setPlacementDraft: ((placement: ChallengePlacement | null) => void) | undefined;
    const Harness = () => {
      const [placement, setPlacement] = useState<ChallengePlacement | null>(null);
      setPlacementDraft = setPlacement;
      return <BingoAdminPanel
        api={api}
        canUndo
        initialUndoTargets={[]}
        onBoardUpdate={vi.fn()}
        onPlacementDraftChange={setPlacement}
        onUndoTargetsChange={vi.fn()}
        online
        placementDraft={placement}
        update={null}
      />;
    };
    render(<Harness />);
    await screen.findByRole("grid", { name: "Testkarte" });

    fireEvent.change(screen.getByRole("spinbutton", { name: "Platzierung X" }), { target: { value: "20" } });
    await user.click(screen.getByRole("button", { name: "Karte speichern" }));
    await waitFor(() => expect(api.saveBingoCard).toHaveBeenCalledOnce());
    const firstRequest = vi.mocked(api.saveBingoCard).mock.calls[0]?.[0];
    expect(firstRequest?.placement.x).toBe(20);

    act(() => setPlacementDraft?.({ x: 30, y: 8, scale: 1 }));
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Platzierung X" })).toHaveValue(30));
    await act(async () => {
      resolveFirstSave?.(mutation({ ...createBoard(), cardRevision: 8, placement: firstRequest?.placement ?? createBoard().placement }));
      await Promise.resolve();
    });

    expect(screen.getByRole("spinbutton", { name: "Platzierung X" })).toHaveValue(30);
    expect(screen.getByRole("button", { name: "Karte speichern" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Karte speichern" }));
    await waitFor(() => expect(api.saveBingoCard).toHaveBeenCalledTimes(2));
    expect(api.saveBingoCard).toHaveBeenLastCalledWith(expect.objectContaining({
      placement: { x: 30, y: 8, scale: 1 },
      expectedCardRevision: 8,
    }));
  });

  it("behält bei einer verspäteten Einstellungsantwort den neuesten Broadcast und dessen Revision", async () => {
    const api = createApi({
      saveBingoSettings: vi.fn((request: BingoSettingsSaveRequest) => {
        if (vi.mocked(api.saveBingoSettings).mock.calls.length === 1) {
          return new Promise<BingoMutationResponse>((resolve) => { resolveSettingsSave = resolve; });
        }
        return Promise.resolve(mutation({ ...createBoard(), settings: request.settings, settingsRevision: 4 }));
      }),
    });
    let resolveSettingsSave: ((response: BingoMutationResponse) => void) | undefined;
    let settingsHandle: BingoAdminSaveHandle | null = null;
    const props = {
      api,
      canUndo: true,
      initialUndoTargets: [],
      onBoardUpdate: vi.fn(),
      onSettingsHandleChange: (handle: BingoAdminSaveHandle) => { settingsHandle = handle; },
      onUndoTargetsChange: vi.fn(),
      online: true,
    };
    const { rerender } = render(<BingoAdminPanel {...props} update={null} />);
    await screen.findByRole("grid", { name: "Testkarte" });

    fireEvent.change(screen.getByRole("slider", { name: "Textgröße" }), { target: { value: "1.5" } });
    await waitFor(() => expect(settingsHandle?.dirty).toBe(true));
    let savePromise: Promise<{ ok: boolean; conflict: boolean; message?: string }> | undefined;
    act(() => { savePromise = settingsHandle?.save(); });
    await waitFor(() => expect(api.saveBingoSettings).toHaveBeenCalledOnce());

    const responseBoard = { ...createBoard(), settings: { ...createBoard().settings, textScale: 1.5 }, settingsRevision: 2 };
    const latestBoard: BingoBoardState = { ...createBoard(), settings: { ...createBoard().settings, backgroundOpacity: 75, textScale: 1.25 }, settingsRevision: 3 };
    rerender(<BingoAdminPanel {...props} update={update(responseBoard)} />);
    rerender(<BingoAdminPanel {...props} update={update(latestBoard)} />);

    await act(async () => {
      resolveSettingsSave?.(mutation(responseBoard));
      await savePromise;
    });

    expect(screen.getByRole("slider", { name: "Textgröße" })).toHaveValue("1.25");
    expect(screen.getByRole("combobox", { name: "Hintergrund" })).toHaveValue("75");
    fireEvent.change(screen.getByRole("slider", { name: "Textgröße" }), { target: { value: "1.4" } });
    await waitFor(() => expect(settingsHandle?.dirty).toBe(true));
    await act(async () => { await settingsHandle?.save(); });
    expect(api.saveBingoSettings).toHaveBeenLastCalledWith(expect.objectContaining({ baseSettingsRevision: 3 }));
  });

  it("verdrahtet Dateiimport und Download-Export", async () => {
    const user = userEvent.setup();
    const api = createApi();
    renderPanel(api);
    await screen.findByRole("grid", { name: "Testkarte" });
    const fileText = JSON.stringify({ format: "questframe-bingo", version: 1, card: createBoard().card });
    const file = new File([fileText], "karte.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve(fileText) });

    await user.upload(screen.getByLabelText("Bingo-Karte importieren"), file);
    await waitFor(() => expect(api.importBingoCard).toHaveBeenCalledWith(fileText, 7));

    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await user.click(screen.getByRole("button", { name: "Karte exportieren" }));
    expect(api.exportBingoCard).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
  });

  // Ergänzt von Codex.
  // Value: protects=Regie lädt Vorlagen, speichert eigene Sets und löscht sie; fails_when=UI-Auswahl oder Buttons falsche API-Aufrufe auslösen; why_new=API-Routen sind getestet, der Regie-Ablauf fehlt; seam=none; no_claim=API im Komponententest gemockt
  it("lädt eine Vorlage, speichert ein eigenes Set und löscht es wieder", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const timestamp = "2026-11-12T12:00:00.000Z";
    const api = createApi({
      listBingoSets: vi.fn(() => Promise.resolve({ sets: [{
        id: "template-1",
        type: "template" as const,
        name: "Vorlage",
        sortOrder: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }] })),
      loadBingoSet: vi.fn(() => Promise.resolve(mutation({
        ...createBoard(),
        card: { ...createBoard().card, title: "Geladene Vorlage" },
        cardRevision: 8,
        markRevision: 5,
      }))),
      saveBingoSet: vi.fn(() => Promise.resolve({
        summary: {
          id: "user-1",
          type: "user" as const,
          name: "Mein Set",
          sortOrder: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        card: createBoard().card,
      })),
    });
    renderPanel(api);

    await screen.findByRole("grid", { name: "Testkarte" });
    await user.selectOptions(await screen.findByRole("combobox", { name: "Vorlage oder gespeichertes Set" }), "template-1");
    expect(api.loadBingoSet).toHaveBeenCalledWith("template-1", 7);
    expect(await screen.findByRole("grid", { name: "Geladene Vorlage" })).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Als Set speichern" }), "Mein Set");
    await user.click(screen.getByRole("button", { name: "Set speichern" }));
    await waitFor(() => expect(api.saveBingoSet).toHaveBeenCalledWith("Mein Set"));
    expect(await screen.findByRole("option", { name: "Gespeichert · Mein Set" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Set löschen" }));
    expect(confirm).toHaveBeenCalledWith('Set „Mein Set“ löschen?');
    await waitFor(() => expect(api.deleteBingoSet).toHaveBeenCalledWith("user-1"));
    expect(screen.queryByRole("option", { name: "Gespeichert · Mein Set" })).not.toBeInTheDocument();
  });

  it("benennt das ausgewählte Set inline um und übernimmt die Antwort in die Setliste", async () => {
    const user = userEvent.setup();
    const api = createApi({
      listBingoSets: vi.fn(() => Promise.resolve({ sets: [{ id: "template-1", type: "template" as const, name: "Vorlage", sortOrder: 0, createdAt: "2026-11-12T12:00:00.000Z", updatedAt: "2026-11-12T12:00:00.000Z" }] })),
    });
    renderPanel(api);

    await user.selectOptions(await screen.findByRole("combobox", { name: "Vorlage oder gespeichertes Set" }), "template-1");
    await user.click(await screen.findByRole("button", { name: "Set umbenennen" }));
    const input = await screen.findByRole("textbox", { name: "Neuer Setname" });
    await user.clear(input);
    await user.type(input, "Gaming-Abend");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(api.renameBingoSet).toHaveBeenCalledWith("template-1", "Gaming-Abend"));
    expect(await screen.findByRole("option", { name: "Vorlage · Gaming-Abend" })).toBeInTheDocument();
  });

  it("behält eine neuere Setlisten-Übertragung bei einer verspäteten Umbenennungsantwort", async () => {
    const user = userEvent.setup();
    const timestamp = "2026-11-12T12:00:00.000Z";
    let resolveRename: ((response: BingoSetResponse) => void) | undefined;
    const api = createApi({
      renameBingoSet: vi.fn(() => new Promise<BingoSetResponse>((resolve) => { resolveRename = resolve; })),
    });
    const props = {
      api,
      canUndo: true,
      initialUndoTargets: [],
      onBoardUpdate: vi.fn(),
      onUndoTargetsChange: vi.fn(),
      online: true,
      update: null,
      onServerSetsChange: vi.fn(),
    };
    const initialSet = { id: "template-1", type: "template" as const, name: "Vorlage", sortOrder: 0, createdAt: timestamp, updatedAt: timestamp };
    const initialSets = [initialSet];
    const { rerender } = render(<BingoAdminPanel {...props} serverSets={initialSets} />);

    await user.selectOptions(await screen.findByRole("combobox", { name: "Vorlage oder gespeichertes Set" }), "template-1");
    await user.click(await screen.findByRole("button", { name: "Set umbenennen" }));
    const input = await screen.findByRole("textbox", { name: "Neuer Setname" });
    await user.clear(input);
    await user.type(input, "Gaming-Neu");
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    const newerSets = [{ ...initialSet, name: "Gaming-Aktuell", updatedAt: "2026-11-13T12:00:00.000Z" }];
    rerender(<BingoAdminPanel {...props} serverSets={newerSets} />);
    await act(async () => {
      resolveRename?.({
        summary: { ...initialSet, name: "Gaming-Neu", updatedAt: "2026-11-13T11:00:00.000Z" },
        card: createBoard().card,
      });
      await Promise.resolve();
    });

    expect(props.onServerSetsChange).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "Vorlage · Gaming-Aktuell" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Vorlage · Gaming-Neu" })).not.toBeInTheDocument();
  });

  it("verwirft eine Umbenennungsantwort, wenn Broadcast und Antwort im selben React-Batch eintreffen", async () => {
    const user = userEvent.setup();
    const timestamp = "2026-11-12T12:00:00.000Z";
    let resolveRename: ((response: BingoSetResponse) => void) | undefined;
    const api = createApi({
      renameBingoSet: vi.fn(() => new Promise<BingoSetResponse>((resolve) => { resolveRename = resolve; })),
    });
    const initialSet = { id: "template-1", type: "template" as const, name: "Vorlage", sortOrder: 0, createdAt: timestamp, updatedAt: timestamp };
    const initialSets = [initialSet];
    let publishSets: (sets: BingoSetSummary[]) => void = () => undefined;
    const Harness = () => {
      const [sets, setSets] = useState<BingoSetSummary[]>(initialSets);
      publishSets = setSets;
      return <BingoAdminPanel
        api={api}
        canUndo
        initialUndoTargets={[]}
        onBoardUpdate={vi.fn()}
        onUndoTargetsChange={vi.fn()}
        online
        serverSets={sets}
        onServerSetsChange={setSets}
        update={null}
      />;
    };
    render(<Harness />);

    await user.selectOptions(await screen.findByRole("combobox", { name: "Vorlage oder gespeichertes Set" }), "template-1");
    await user.click(await screen.findByRole("button", { name: "Set umbenennen" }));
    const input = await screen.findByRole("textbox", { name: "Neuer Setname" });
    await user.clear(input);
    await user.type(input, "Gaming-Spät");
    await user.click(screen.getByRole("button", { name: "Speichern" }));

    await act(async () => {
      publishSets([{ ...initialSet, name: "Gaming-Aktuell", updatedAt: "2026-11-13T12:00:00.000Z" }]);
      resolveRename?.({
        summary: { ...initialSet, name: "Gaming-Spät", updatedAt: "2026-11-13T11:00:00.000Z" },
        card: createBoard().card,
      });
      await Promise.resolve();
    });

    expect(screen.getByRole("option", { name: "Vorlage · Gaming-Aktuell" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Vorlage · Gaming-Spät" })).not.toBeInTheDocument();
  });

  it("fragt vor dem Überschreiben eines eigenen Sets nach und bricht Vorlagenüberschreibungen klar ab", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const timestamp = "2026-11-12T12:00:00.000Z";
    const api = createApi({
      listBingoSets: vi.fn(() => Promise.resolve({ sets: [
        { id: "user-1", type: "user" as const, name: "Mein Set", sortOrder: 1, createdAt: timestamp, updatedAt: timestamp },
        { id: "template-1", type: "template" as const, name: "Vorlage", sortOrder: 0, createdAt: timestamp, updatedAt: timestamp },
      ] })),
    });
    renderPanel(api);
    await screen.findByRole("grid", { name: "Testkarte" });

    await user.type(screen.getByRole("textbox", { name: "Als Set speichern" }), "Mein Set");
    await user.click(screen.getByRole("button", { name: "Set speichern" }));
    expect(confirm).toHaveBeenCalledWith('Set „Mein Set“ überschreiben?');
    await waitFor(() => expect(api.saveBingoSet).toHaveBeenCalledWith("Mein Set", "user-1"));

    const nameInput = screen.getByRole("textbox", { name: "Als Set speichern" });
    await user.clear(nameInput);
    await user.type(nameInput, "Vorlage");
    await user.click(screen.getByRole("button", { name: "Set speichern" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Vorlage.*nicht überschrieben/i);
    expect(api.saveBingoSet).toHaveBeenCalledTimes(1);
  });

  it("setzt Kreuze erst nach Bestätigung zurück", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const api = createApi();
    renderPanel(api);

    await user.click(await screen.findByRole("button", { name: "Kreuze zurücksetzen" }));

    expect(confirm).toHaveBeenCalled();
    expect(api.resetBingoMarks).toHaveBeenCalledWith(4);
  });

  it("setzt den Stil mit der aktuellen Kartenrevision und aktualisiert die Regie-Vorschau", async () => {
    const user = userEvent.setup();
    const api = createApi();
    renderPanel(api);

    await user.selectOptions(await screen.findByRole("combobox", { name: "Bingo-Stil" }), "broadcast");

    expect(api.setBingoStyle).toHaveBeenCalledWith("broadcast", 7);
    await waitFor(() => expect(document.querySelector('.bingo-admin-live-card .bingo-source[data-style="broadcast"]')).not.toBeNull());
    expect(document.querySelector('.bingo-admin-live-card .bingo-source[data-style="broadcast"]')).not.toBeNull();
  });

  it("zeigt einen Stilkonflikt im reservierten Nachrichtenfeld", async () => {
    const user = userEvent.setup();
    const currentSnapshot = { ...createBoard(), style: "broadcast" as const, cardRevision: 8 };
    const conflict = Object.assign(new Error("Die Bingo-Karte wurde inzwischen geändert."), {
      code: "revision_conflict",
      currentSnapshot,
    });
    const api = createApi();
    api.setBingoStyle = vi.fn(() => Promise.reject(conflict));
    renderPanel(api);

    await user.selectOptions(await screen.findByRole("combobox", { name: "Bingo-Stil" }), "broadcast");

    const alert = await screen.findByRole("alert");
    expect(api.setBingoStyle).toHaveBeenCalledWith("broadcast", 7);
    expect(alert).toHaveTextContent("Die Bingo-Karte wurde inzwischen geändert.");
    expect(alert.closest(".bingo-admin-message-slot")).toBeInTheDocument();
  });
});
