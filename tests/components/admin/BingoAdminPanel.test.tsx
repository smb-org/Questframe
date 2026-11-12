import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BingoAdminPanel, type BingoAdminApi } from "../../../src/modules/bingo/ui/BingoAdminPanel";
import type {
  BingoBoardState,
  BingoCardSaveRequest,
  BingoSetResponse,
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

  it("setzt Kreuze erst nach Bestätigung zurück", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const api = createApi();
    renderPanel(api);

    await user.click(await screen.findByRole("button", { name: "Kreuze zurücksetzen" }));

    expect(confirm).toHaveBeenCalled();
    expect(api.resetBingoMarks).toHaveBeenCalledWith(4);
  });
});
