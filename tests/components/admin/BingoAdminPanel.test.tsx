import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BingoAdminPanel, type BingoAdminApi } from "../../../src/modules/bingo/ui/BingoAdminPanel";
import type {
  BingoBoardState,
  BingoCardSaveRequest,
  BingoMutationResponse,
  BingoSetResponse,
  BingoStyleId,
  BingoUndoResponse,
  BingoUpdateMessage,
  MarkCellPayload,
} from "../../../src/modules/bingo/contracts/schemas";
import type { BingoUndoBaseRevisions } from "../../../src/shared/contracts/api";

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
  listBingoSets: vi.fn(() => Promise.resolve({ sets: [] })),
  getBingoSet: vi.fn((setId: string) => { void setId; return Promise.resolve({ summary: { id: "set-1", type: "template" as const, name: "Vorlage", sortOrder: 0, createdAt: "2026-11-12T12:00:00.000Z", updatedAt: "2026-11-12T12:00:00.000Z" }, card: createBoard().card } satisfies BingoSetResponse); }),
  saveBingoSet: vi.fn((name: string) => { void name; return Promise.resolve({ summary: { id: "set-1", type: "user" as const, name: "Mein Set", sortOrder: 0, createdAt: "2026-11-12T12:00:00.000Z", updatedAt: "2026-11-12T12:00:00.000Z" }, card: createBoard().card } satisfies BingoSetResponse); }),
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
