import { Download, Trash2, Undo2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BingoUndoBaseRevisions, UndoTarget } from "../../../shared/contracts/api";
import type { ChallengePlacement } from "../../../shared/contracts/win-challenges";
import {
  bingoBoardStateSchema,
  type BingoBoardState,
  type BingoCard,
  type BingoCardSaveRequest,
  type BingoMutationResponse,
  type BingoSetResponse,
  type BingoSetSummary,
  type BingoStyleId,
  type BingoUndoResponse,
  type BingoUpdateMessage,
  type MarkCellPayload,
} from "../contracts/schemas";
import { decodeBingoCard } from "../domain/card-codec";
import { loadBingoStyle } from "../../../bingo/style-loader";
import { BingoBoard } from "../../../bingo/BingoBoard";
import "./bingo-admin.css";

type BingoCardDraft = Pick<BingoCard, "title" | "size" | "cells"> & {
  placement: ChallengePlacement;
};

export type BingoAdminApi = {
  getBingoBoard: () => Promise<BingoBoardState>;
  markBingoCell: (request: MarkCellPayload) => Promise<BingoMutationResponse>;
  resetBingoMarks: (expectedMarkRevision: number) => Promise<BingoMutationResponse>;
  saveBingoCard: (request: BingoCardSaveRequest) => Promise<BingoMutationResponse>;
  setBingoStyle: (style: BingoStyleId, expectedCardRevision: number) => Promise<BingoMutationResponse>;
  listBingoSets: () => Promise<{ sets: BingoSetSummary[] }>;
  getBingoSet: (setId: string) => Promise<BingoSetResponse>;
  saveBingoSet: (name: string) => Promise<BingoSetResponse>;
  deleteBingoSet: (setId: string) => Promise<string>;
  loadBingoSet: (setId: string, expectedCardRevision: number) => Promise<BingoMutationResponse>;
  importBingoCard: (file: string, expectedCardRevision: number) => Promise<BingoMutationResponse>;
  exportBingoCard: () => Promise<string>;
  undo?: (moduleId: "bingo", channelSeq: number, baseRevision: BingoUndoBaseRevisions) => Promise<BingoUndoResponse>;
};

const segmenter = new Intl.Segmenter("de", { granularity: "grapheme" });

const graphemeCount = (value: string): number => [...segmenter.segment(value)].length;

const draftFromBoard = (board: BingoBoardState): BingoCardDraft => ({
  ...board.card,
  placement: board.placement,
});

const sameDraft = (left: BingoCardDraft | null, right: BingoCardDraft, board: BingoBoardState | null): boolean =>
  board !== null
  && left !== null
  && left.title === board.card.title
  && left.size === board.card.size
  && JSON.stringify(left.cells) === JSON.stringify(board.card.cells)
  && left.placement.x === board.placement.x
  && left.placement.y === board.placement.y
  && left.placement.scale === board.placement.scale
  && left.title === right.title
  && left.size === right.size
  && JSON.stringify(left.cells) === JSON.stringify(right.cells)
  && left.placement.x === right.placement.x
  && left.placement.y === right.placement.y
  && left.placement.scale === right.placement.scale;

const cellsForSize = (cells: BingoCard["cells"], size: BingoCard["size"]): BingoCard["cells"] => {
  const usedIds = new Set(cells.map(({ id }) => id));
  return Array.from({ length: size * size }, (_, index) => {
    const existing = cells[index];
    if (existing !== undefined) return existing;
    let candidate = index;
    let id = `cell-${String(candidate)}`;
    while (usedIds.has(id)) {
      candidate += 1;
      id = `cell-${String(candidate)}`;
    }
    usedIds.add(id);
    return { id, text: `Feld ${String(index + 1)}` };
  });
};

const updateFromBoard = (board: BingoBoardState): BingoUpdateMessage => ({ type: "bingo_update", board });

const fileNameFor = (title: string): string => {
  const safe = title.normalize("NFKD").replace(/[^\p{Letter}\p{Number}-]+/gu, "-").replace(/^-+|-+$/gu, "").toLowerCase();
  return `${safe || "bingo-karte"}.json`;
};

const downloadFile = (text: string, fileName: string): void => {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

const responseBoard = (value: unknown): BingoBoardState | null => {
  if (typeof value !== "object" || value === null) return null;
  const snapshot = "board" in value ? value.board : value;
  const parsed = bingoBoardStateSchema.safeParse(snapshot);
  return parsed.success ? parsed.data : null;
};

export const BingoAdminPanel = ({
  api,
  online,
  canUndo,
  initialUndoTargets,
  update,
  onBoardUpdate,
  onUndoTargetsChange,
  placementDraft,
  onPlacementDraftChange,
}: {
  api: BingoAdminApi;
  online: boolean;
  canUndo: boolean;
  initialUndoTargets: UndoTarget[];
  update: BingoUpdateMessage | null;
  onBoardUpdate: (update: BingoUpdateMessage) => void;
  onUndoTargetsChange: (targets: UndoTarget[]) => void;
  placementDraft?: ChallengePlacement | null;
  onPlacementDraftChange?: (placement: ChallengePlacement) => void;
}) => {
  const [board, setBoard] = useState<BingoBoardState | null>(null);
  const [draft, setDraft] = useState<BingoCardDraft | null>(null);
  const [serverSets, setServerSets] = useState<BingoSetSummary[]>([]);
  const [selectedSet, setSelectedSet] = useState("");
  const [setName, setSetName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [conflicted, setConflicted] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const boardRef = useRef<BingoBoardState | null>(null);
  const draftRef = useRef<BingoCardDraft | null>(null);
  const draftBaseCardRevisionRef = useRef<number | null>(null);
  const boardStyle = board?.style;
  const effectivePlacement = placementDraft ?? draft?.placement ?? board?.placement ?? null;
  const dirty = useMemo(() => draft !== null && board !== null && !sameDraft(draft, draft, board), [board, draft]);
  const undoTargets = initialUndoTargets
    .filter((target) => target.moduleId === "bingo")
    .sort((left, right) => right.channelSeq - left.channelSeq)
    .slice(0, 6);

  useEffect(() => { boardRef.current = board; }, [board]);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => {
    if (boardStyle !== undefined) void loadBingoStyle(boardStyle).catch(() => undefined);
  }, [boardStyle]);

  const applyBoard = useCallback((nextBoard: BingoBoardState, nextUpdate = updateFromBoard(nextBoard), syncDraft = false): void => {
    const current = boardRef.current;
    if (current !== null && (
      nextBoard.cardRevision < current.cardRevision
      || nextBoard.markRevision < current.markRevision
    )) return;
    const currentDraft = draftRef.current;
    const editorWasClean = syncDraft || current === null || sameDraft(currentDraft, currentDraft ?? draftFromBoard(current), current);
    boardRef.current = nextBoard;
    setBoard(nextBoard);
    if (editorWasClean) {
      const nextDraft = draftFromBoard(nextBoard);
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      draftBaseCardRevisionRef.current = nextBoard.cardRevision;
      setConflicted(false);
      setError("");
      onPlacementDraftChange?.(nextDraft.placement);
    }
    onBoardUpdate(nextUpdate);
  }, [onBoardUpdate, onPlacementDraftChange]);

  const showError = useCallback((caught: unknown, fallback: string): void => {
    const errorValue = typeof caught === "object" && caught !== null ? caught as { message?: unknown; code?: unknown; currentSnapshot?: unknown } : {};
    const current = errorValue.code === "revision_conflict" ? responseBoard(errorValue.currentSnapshot) : null;
    const baseCardRevision = draftBaseCardRevisionRef.current ?? boardRef.current?.cardRevision ?? current?.cardRevision ?? 0;
    if (current !== null && current.cardRevision > baseCardRevision) setConflicted(true);
    const latest = boardRef.current;
    if (current !== null && (latest === null || (
      current.cardRevision >= latest.cardRevision
      && current.markRevision >= latest.markRevision
    ))) {
      boardRef.current = current;
      setBoard(current);
    }
    setMessage("");
    setError(typeof errorValue.message === "string" ? errorValue.message : fallback);
  }, []);

  const applyMutation = useCallback((result: BingoMutationResponse, syncDraft = false): void => {
    applyBoard(result.board, result.update ?? updateFromBoard(result.board), syncDraft);
    onUndoTargetsChange(result.undoTargets);
  }, [applyBoard, onUndoTargetsChange]);

  useEffect(() => {
    let disposed = false;
    void api.getBingoBoard().then((initial) => {
      if (disposed) return;
      const current = boardRef.current;
      if (current !== null && current.cardRevision >= initial.cardRevision && current.markRevision >= initial.markRevision) return;
      boardRef.current = initial;
      setBoard(initial);
      const nextDraft = draftFromBoard(initial);
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      draftBaseCardRevisionRef.current = initial.cardRevision;
      onPlacementDraftChange?.(nextDraft.placement);
      onBoardUpdate(updateFromBoard(initial));
    }).catch((caught: unknown) => showError(caught, "Bingo-Board konnte nicht geladen werden."))
      .finally(() => { if (!disposed) setLoading(false); });
    void api.listBingoSets().then(({ sets }) => { if (!disposed) setServerSets(sets); }).catch(() => undefined);
    return () => { disposed = true; };
  }, [api, onBoardUpdate, onPlacementDraftChange, showError]);

  useEffect(() => {
    if (update === null) return;
    const current = boardRef.current;
    if (current !== null && (
      update.board.cardRevision < current.cardRevision
      || update.board.markRevision < current.markRevision
      || (update.board.cardRevision === current.cardRevision && update.board.markRevision === current.markRevision)
    )) return;
    const localDraft = draftRef.current;
    const wasDirty = current !== null && !sameDraft(localDraft, localDraft ?? draftFromBoard(current), current);
    const draftMatchesUpdate = localDraft !== null && sameDraft(localDraft, localDraft, update.board);
    boardRef.current = update.board;
    setBoard(update.board);
    if (!wasDirty || draftMatchesUpdate) {
      const nextDraft = draftFromBoard(update.board);
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      draftBaseCardRevisionRef.current = update.board.cardRevision;
      setConflicted(false);
      setError("");
      setMessage("");
      onPlacementDraftChange?.(nextDraft.placement);
    } else if (update.board.cardRevision > current.cardRevision) {
      setConflicted(true);
      setError("Die Bingo-Karte wurde parallel geändert. Dein Entwurf bleibt erhalten.");
      setMessage("");
    }
  }, [onPlacementDraftChange, update]);

  const changeDraft = (next: BingoCardDraft): void => {
    draftRef.current = next;
    setDraft(next);
    onPlacementDraftChange?.(next.placement);
    if (!conflicted) setError("");
    setMessage("");
  };

  const markCell = async (cellId: string, marked: boolean): Promise<void> => {
    const current = boardRef.current;
    if (current === null || busy || !online) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      applyMutation(await api.markBingoCell({ cellId, marked, expectedMarkRevision: current.markRevision }));
    } catch (caught) {
      showError(caught, "Bingo-Feld konnte nicht geändert werden.");
    } finally {
      setBusy(false);
    }
  };

  const changeStyle = async (style: BingoStyleId): Promise<void> => {
    const current = boardRef.current;
    if (current === null || current.style === style || busy || !online || conflicted || dirty) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      applyMutation(await api.setBingoStyle(style, current.cardRevision));
      setMessage("Bingo-Stil geändert.");
    } catch (caught) {
      showError(caught, "Bingo-Stil konnte nicht geändert werden.");
    } finally {
      setBusy(false);
    }
  };

  const resetMarks = async (): Promise<void> => {
    const current = boardRef.current;
    if (current === null || busy || !online || !window.confirm("Alle Bingo-Kreuze zurücksetzen?")) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      applyMutation(await api.resetBingoMarks(current.markRevision));
      setMessage("Alle Bingo-Kreuze wurden zurückgesetzt.");
    } catch (caught) {
      showError(caught, "Die Bingo-Kreuze konnten nicht zurückgesetzt werden.");
    } finally {
      setBusy(false);
    }
  };

  const saveCard = async (): Promise<void> => {
    const current = boardRef.current;
    const editing = draftRef.current;
    if (current === null || editing === null || busy || !online || conflicted) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api.saveBingoCard({ ...editing, placement: effectivePlacement ?? editing.placement, expectedCardRevision: draftBaseCardRevisionRef.current ?? current.cardRevision });
      applyMutation(result, true);
      setMessage(`Karte gespeichert · Revision ${String(result.board.cardRevision)}.`);
    } catch (caught) {
      showError(caught, "Die Bingo-Karte konnte nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  };

  const loadSet = async (setId: string): Promise<void> => {
    const current = boardRef.current;
    if (current === null || setId === "" || busy || !online) return;
    if (dirty && !window.confirm("Den ungespeicherten Entwurf durch dieses Set ersetzen?")) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api.loadBingoSet(setId, current.cardRevision);
      applyMutation(result, true);
      setSelectedSet(setId);
      setMessage("Bingo-Set geladen.");
    } catch (caught) {
      showError(caught, "Bingo-Set konnte nicht geladen werden.");
    } finally {
      setBusy(false);
    }
  };

  const saveSet = async (): Promise<void> => {
    if (setName.trim() === "" || busy || !online || dirty) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const saved = await api.saveBingoSet(setName.trim());
      setServerSets((sets) => [...sets.filter((set) => set.id !== saved.summary.id), saved.summary]);
      setSelectedSet(saved.summary.id);
      setSetName("");
      setMessage("Bingo-Set gespeichert.");
    } catch (caught) {
      showError(caught, "Bingo-Set konnte nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  };

  const deleteSet = async (): Promise<void> => {
    const selected = serverSets.find((set) => set.id === selectedSet);
    if (selected?.type !== "user" || busy || !online || !window.confirm(`Set „${selected.name}“ löschen?`)) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.deleteBingoSet(selected.id);
      setServerSets((sets) => sets.filter((set) => set.id !== selected.id));
      setSelectedSet("");
      setMessage("Bingo-Set gelöscht.");
    } catch (caught) {
      showError(caught, "Bingo-Set konnte nicht gelöscht werden.");
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File | undefined): Promise<void> => {
    const current = boardRef.current;
    if (file === undefined || current === null || busy || !online) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const text = await file.text();
      const decoded = decodeBingoCard(text);
      if (!decoded.ok) throw new Error(decoded.error.message);
      applyMutation(await api.importBingoCard(text, current.cardRevision), true);
      setMessage("Bingo-Karte importiert.");
    } catch (caught) {
      showError(caught, "Bingo-Karte konnte nicht importiert werden.");
    } finally {
      setBusy(false);
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
    }
  };

  const exportCard = async (): Promise<void> => {
    const current = boardRef.current;
    if (current === null || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      downloadFile(await api.exportBingoCard(), fileNameFor(current.card.title));
      setMessage("Bingo-Karte exportiert.");
    } catch (caught) {
      showError(caught, "Bingo-Karte konnte nicht exportiert werden.");
    } finally {
      setBusy(false);
    }
  };

  const undo = async (target: UndoTarget): Promise<void> => {
    const current = boardRef.current;
    if (api.undo === undefined || current === null || busy || !online) return;
    if (!window.confirm(`Bingo-Zustand aus Kanalsequenz ${String(target.channelSeq)} wiederherstellen?`)) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api.undo("bingo", target.channelSeq, {
        cardRevision: current.cardRevision,
        markRevision: current.markRevision,
        generation: current.generation,
        style: current.style,
      });
      const restored = bingoBoardStateSchema.parse(result.board);
      applyBoard(restored);
      onUndoTargetsChange(result.undoTargets);
      setMessage("Der Bingo-Zustand wurde wiederhergestellt.");
    } catch (caught) {
      showError(caught, "Bingo-Undo fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  };

  const selectedSetRecord = serverSets.find((set) => set.id === selectedSet);
  const placement = effectivePlacement ?? { x: 0, y: 0, scale: 1 };
  const takeServerCard = (): void => {
    const current = boardRef.current;
    if (current === null) return;
    const nextDraft = draftFromBoard(current);
    draftRef.current = nextDraft;
    draftBaseCardRevisionRef.current = current.cardRevision;
    setDraft(nextDraft);
    setConflicted(false);
    setError("");
    setMessage("Aktuelle Bingo-Karte geladen.");
    onPlacementDraftChange?.(nextDraft.placement);
  };

  return (
    <section aria-busy={busy || loading} className="bingo-admin-panel">
      <header className="bingo-admin-heading">
        <div><span className="eyebrow">Bingo-Modul</span><h1>Bingo</h1></div>
        <span className={`bingo-admin-connection ${online ? "is-online" : "is-offline"}`}><i aria-hidden="true" />{online ? "Live verbunden" : "Offline"}</span>
      </header>

      <div aria-live="polite" className={`bingo-admin-message-slot ${conflicted || error !== "" ? "has-error" : message !== "" ? "has-message" : ""}`}>
        {conflicted ? <>
          <span role="alert">{error || "Die Bingo-Karte wurde parallel geändert. Dein Entwurf bleibt erhalten."}</span>
          {board !== null && <button className="button button--quiet bingo-admin-message-action" onClick={takeServerCard} type="button">Aktuelle Karte übernehmen</button>}
        </> : error !== "" ? <span role="alert">{error}</span> : message !== "" ? <span>{message}</span> : dirty ? <span>Stil erst nach dem Speichern des Kartenentwurfs ändern.</span> : <span aria-hidden="true">&nbsp;</span>}
      </div>

      <section aria-labelledby="bingo-live-heading" className="bingo-admin-live-card">
        <div className="bingo-admin-section-heading">
          <div><span className="eyebrow">Regie</span><h2 id="bingo-live-heading">Kartenkachel</h2></div>
          <button className="button button--quiet" disabled={board === null || busy || !online} onClick={() => void resetMarks()} type="button">Kreuze zurücksetzen</button>
        </div>
        <div className="bingo-admin-board-slot">
          {board === null
            ? <div aria-hidden="true" className="bingo-admin-card-placeholder" />
            : <BingoBoard board={board} onToggleCell={(cellId, marked) => void markCell(cellId, marked)} width={350} />}
        </div>
        {canUndo && (
          <details className="bingo-admin-undo" open>
            <summary><Undo2 size={14} /> Rückgängig</summary>
            {undoTargets.length === 0
              ? <p className="empty-copy">Noch keine Bingo-Änderungen.</p>
              : undoTargets.map((target) => <button disabled={busy || !online} key={target.channelSeq} onClick={() => void undo(target)} type="button">Kanal {target.channelSeq}<span>{target.summary}</span></button>)}
          </details>
        )}
      </section>

      <section aria-labelledby="bingo-editor-heading" className="bingo-admin-editor">
        <div className="bingo-admin-section-heading">
          <div><span className="eyebrow">Karteneditor</span><h2 id="bingo-editor-heading">Karte bearbeiten</h2></div>
          <button className="button button--primary" disabled={board === null || draft === null || busy || !online || conflicted} onClick={() => void saveCard()} type="button">{busy ? "Wird gespeichert …" : "Karte speichern"}</button>
        </div>

        <div className="bingo-admin-card-fields">
          <label><span>Kartentitel</span><input disabled={draft === null || busy || !online} maxLength={24} onChange={(event) => { if (draft !== null) changeDraft({ ...draft, title: event.currentTarget.value }); }} type="text" value={draft?.title ?? ""} /></label>
          <label><span>Kartengröße</span><select disabled={draft === null || busy || !online} onChange={(event) => { if (draft !== null) { const size = Number(event.currentTarget.value) as BingoCardDraft["size"]; changeDraft({ ...draft, size, cells: cellsForSize(draft.cells, size) }); } }} value={draft?.size ?? 3}>{[3, 4, 5].map((size) => <option key={size} value={size}>{size} × {size}</option>)}</select></label>
          <label><span>Stil</span><select aria-label="Bingo-Stil" disabled={board === null || busy || !online || conflicted || dirty} onChange={(event) => void changeStyle(event.currentTarget.value as BingoStyleId)} value={board?.style ?? "marker"}><option value="marker">Marker</option><option value="broadcast">Broadcast</option></select></label>
        </div>

        <div className="bingo-admin-set-tools">
          <label className="bingo-admin-set-select"><span>Vorlage oder gespeichertes Set</span><select disabled={busy || !online || board === null} onChange={(event) => { setSelectedSet(event.currentTarget.value); void loadSet(event.currentTarget.value); }} value={selectedSet}><option value="">Set laden …</option>{serverSets.map((set) => <option key={set.id} value={set.id}>{set.type === "template" ? "Vorlage · " : "Gespeichert · "}{set.name}</option>)}</select></label>
          <label><span>Als Set speichern</span><input disabled={busy || !online || dirty} maxLength={24} onChange={(event) => setSetName(event.currentTarget.value)} placeholder="Name des Sets" type="text" value={setName} /></label>
          <button className="button button--quiet" disabled={setName.trim() === "" || dirty || busy || !online} onClick={() => void saveSet()} type="button">Set speichern</button>
          <button className="button button--quiet" disabled={selectedSetRecord?.type !== "user" || busy || !online} onClick={() => void deleteSet()} type="button"><Trash2 size={15} /> Set löschen</button>
          <input accept="application/json,.json" aria-label="Bingo-Karte importieren" hidden onChange={(event) => void importFile(event.currentTarget.files?.[0])} ref={fileInputRef} type="file" />
          <button className="button button--quiet" disabled={busy || !online} onClick={() => fileInputRef.current?.click()} type="button"><Upload size={15} /> Importieren</button>
          <button className="button button--quiet" disabled={board === null || busy} onClick={() => void exportCard()} type="button"><Download size={15} /> Karte exportieren</button>
        </div>

        <div className="bingo-admin-placement" aria-label="Bingo-Platzierung">
          <label><span>Platzierung X</span><input disabled={draft === null || busy || !online} max={384} min={0} onChange={(event) => { if (draft !== null) changeDraft({ ...draft, placement: { ...placement, x: Number(event.currentTarget.value) } }); }} type="number" value={draft?.placement.x ?? placement.x} /></label>
          <label><span>Platzierung Y</span><input disabled={draft === null || busy || !online} max={216} min={0} onChange={(event) => { if (draft !== null) changeDraft({ ...draft, placement: { ...placement, y: Number(event.currentTarget.value) } }); }} type="number" value={draft?.placement.y ?? placement.y} /></label>
          <label><span>Skalierung</span><select disabled={draft === null || busy || !online} onChange={(event) => { if (draft !== null) changeDraft({ ...draft, placement: { ...placement, scale: Number(event.currentTarget.value) } }); }} value={draft?.placement.scale ?? placement.scale}>{[0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map((scale) => <option key={scale} value={scale}>{Math.round(scale * 100)}%</option>)}</select></label>
        </div>

        <div className="bingo-admin-editor-grid">
          {(draft?.cells ?? []).map((cell, index) => {
            const count = graphemeCount(cell.text);
            return (
              <label className="bingo-admin-cell-field" key={cell.id}>
                <span>Feld {String(index + 1)}<small className={count > 40 ? "is-over-limit" : ""}>{String(count)} / 40</small></span>
                <input aria-label={`Feld ${String(index + 1)}`} disabled={draft === null || busy || !online} maxLength={160} onChange={(event) => {
                  if (draft === null) return;
                  const value = event.currentTarget.value;
                  if (graphemeCount(value) <= 40) changeDraft({ ...draft, cells: draft.cells.map((item, itemIndex) => itemIndex === index ? { ...item, text: value } : item) });
                }} type="text" value={cell.text} />
              </label>
            );
          })}
        </div>
      </section>
    </section>
  );
};
