import { Check, Download, Pencil, Trash2, Undo2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";

import type { BingoUndoBaseRevisions, UndoTarget } from "../../../shared/contracts/api";
import type { ChallengePlacement } from "../../../shared/contracts/win-challenges";
import {
  bingoBoardStateSchema,
  type BingoBoardState,
  type BingoCard,
  type BingoCardSaveRequest,
  type BingoMutationResponse,
  type BingoPresentationSettings,
  type BingoSetResponse,
  type BingoSetSummary,
  type BingoStyleId,
  type BingoUndoResponse,
  type BingoUpdateMessage,
  type MarkCellPayload,
} from "../contracts/schemas";
import { decodeBingoCard } from "../domain/card-codec";
import { BingoMarkQueue } from "../domain/mark-queue";
import { loadBingoStyle } from "../../../bingo/style-loader";
import { BingoBoard } from "../../../bingo/BingoBoard";

type BingoCardDraft = Pick<BingoCard, "title" | "size" | "cells"> & {
  placement: ChallengePlacement;
};

export type BingoAdminApi = {
  getBingoBoard: () => Promise<BingoBoardState>;
  markBingoCell: (request: MarkCellPayload) => Promise<BingoMutationResponse>;
  resetBingoMarks: (expectedMarkRevision: number) => Promise<BingoMutationResponse>;
  saveBingoCard: (request: BingoCardSaveRequest) => Promise<BingoMutationResponse>;
  saveBingoSettings: (request: { baseSettingsRevision: number; settings: BingoPresentationSettings }) => Promise<BingoMutationResponse>;
  setBingoStyle: (style: BingoStyleId, expectedCardRevision: number) => Promise<BingoMutationResponse>;
  listBingoSets: () => Promise<{ sets: BingoSetSummary[] }>;
  getBingoSet: (setId: string) => Promise<BingoSetResponse>;
  saveBingoSet: (name: string, overwriteSetId?: string) => Promise<BingoSetResponse>;
  renameBingoSet: (setId: string, name: string) => Promise<BingoSetResponse>;
  deleteBingoSet: (setId: string) => Promise<string>;
  loadBingoSet: (setId: string, expectedCardRevision: number) => Promise<BingoMutationResponse>;
  importBingoCard: (file: string, expectedCardRevision: number) => Promise<BingoMutationResponse>;
  exportBingoCard: () => Promise<string>;
  undo?: (moduleId: "bingo", channelSeq: number, baseRevision: BingoUndoBaseRevisions) => Promise<BingoUndoResponse>;
};

export type BingoAdminSaveOutcome = { ok: boolean; conflict: boolean; message?: string };
export type BingoAdminSaveHandle = { dirty: boolean; save: () => Promise<BingoAdminSaveOutcome> };
export type BingoAdminPanelProps = {
  api: BingoAdminApi;
  online: boolean;
  canUndo: boolean;
  initialUndoTargets: UndoTarget[];
  update: BingoUpdateMessage | null;
  serverSets?: BingoSetSummary[];
  onServerSetsChange?: (sets: SetStateAction<BingoSetSummary[]>) => void;
  onBoardUpdate: (update: BingoUpdateMessage) => void;
  onUndoTargetsChange: (targets: UndoTarget[]) => void;
  placementDraft?: ChallengePlacement | null;
  onPlacementDraftChange?: (placement: ChallengePlacement) => void;
  onSaveHandleChange?: (handle: BingoAdminSaveHandle) => void;
  onSettingsDraftChange?: (settings: BingoPresentationSettings | null) => void;
  onSettingsHandleChange?: (handle: BingoAdminSaveHandle) => void;
};

const segmenter = new Intl.Segmenter("de", { granularity: "grapheme" });

const graphemeCount = (value: string): number => [...segmenter.segment(value)].length;

const draftFromBoard = (board: BingoBoardState): BingoCardDraft => ({
  ...board.card,
  placement: board.placement,
});

const samePlacement = (left: ChallengePlacement, right: ChallengePlacement): boolean =>
  left.x === right.x && left.y === right.y && left.scale === right.scale;

const localPlacementDraft = (
  externalPlacement: ChallengePlacement | null,
  current: BingoBoardState | null,
  incoming: BingoBoardState,
): ChallengePlacement | null => externalPlacement !== null
  && !samePlacement(externalPlacement, current?.placement ?? incoming.placement)
  ? externalPlacement
  : null;

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

const mergeBoardRevisions = (current: BingoBoardState | null, incoming: BingoBoardState): BingoBoardState => {
  if (current === null) return incoming;
  const cardBoard = incoming.cardRevision >= current.cardRevision ? incoming : current;
  const marksBoard = incoming.markRevision >= current.markRevision ? incoming : current;
  const settingsBoard = incoming.settingsRevision >= current.settingsRevision ? incoming : current;
  return {
    ...cardBoard,
    marks: marksBoard.marks,
    markRevision: marksBoard.markRevision,
    generation: marksBoard.generation,
    settings: settingsBoard.settings,
    settingsRevision: settingsBoard.settingsRevision,
  };
};

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
  serverSets: externalServerSets,
  onServerSetsChange,
  onBoardUpdate,
  onUndoTargetsChange,
  placementDraft,
  onPlacementDraftChange,
  onSaveHandleChange,
  onSettingsDraftChange,
  onSettingsHandleChange,
}: BingoAdminPanelProps) => {
  const [board, setBoard] = useState<BingoBoardState | null>(null);
  const [draft, setDraft] = useState<BingoCardDraft | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<BingoPresentationSettings | null>(null);
  const [localServerSets, setLocalServerSets] = useState<BingoSetSummary[]>([]);
  const serverSets = externalServerSets ?? localServerSets;
  const setServerSets = onServerSetsChange ?? setLocalServerSets;
  const serverSetsRef = useRef(serverSets);
  const [selectedSet, setSelectedSet] = useState("");
  const [setName, setSetName] = useState("");
  const [renamingSet, setRenamingSet] = useState(false);
  const [renamingSetId, setRenamingSetId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [markPending, setMarkPending] = useState(false);
  const [resettingMarks, setResettingMarks] = useState(false);
  const markQueueRef = useRef(new BingoMarkQueue());
  const resettingMarksRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [conflicted, setConflicted] = useState(false);
  const [settingsConflicted, setSettingsConflicted] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const boardRef = useRef<BingoBoardState | null>(null);
  const draftRef = useRef<BingoCardDraft | null>(null);
  const settingsDraftRef = useRef<BingoPresentationSettings | null>(null);
  const placementDraftRef = useRef<ChallengePlacement | null>(placementDraft ?? null);
  const draftBaseCardRevisionRef = useRef<number | null>(null);
  const draftBaseSettingsRevisionRef = useRef<number | null>(null);
  const saveCardRef = useRef<() => Promise<BingoAdminSaveOutcome>>(() => Promise.resolve({ ok: false, conflict: false, message: "Nicht speicherbar." }));
  const saveSettingsRef = useRef<() => Promise<BingoAdminSaveOutcome>>(() => Promise.resolve({ ok: false, conflict: false, message: "Nicht speicherbar." }));
  const setBusySync = (next: boolean): void => {
    busyRef.current = next;
    setBusy(next);
  };
  const boardStyle = board?.style;
  const effectivePlacement = placementDraft ?? draft?.placement ?? board?.placement ?? null;
  const dirty = useMemo(() => draft !== null && board !== null && (
    !sameDraft(draft, draft, board)
    || (effectivePlacement !== null && (
      effectivePlacement.x !== board.placement.x
      || effectivePlacement.y !== board.placement.y
      || effectivePlacement.scale !== board.placement.scale
    ))
  ), [board, draft, effectivePlacement]);
  const settingsDirty = settingsDraft !== null && board !== null
    && JSON.stringify(settingsDraft) !== JSON.stringify(board.settings);
  const undoTargets = initialUndoTargets
    .filter((target) => target.moduleId === "bingo")
    .sort((left, right) => right.channelSeq - left.channelSeq)
    .slice(0, 6);

  useEffect(() => { boardRef.current = board; }, [board]);
  useLayoutEffect(() => { serverSetsRef.current = serverSets; }, [serverSets]);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { settingsDraftRef.current = settingsDraft; }, [settingsDraft]);
  useEffect(() => { onSettingsDraftChange?.(settingsDraft); }, [onSettingsDraftChange, settingsDraft]);
  useEffect(() => {
    const externalPlacement = placementDraft ?? null;
    placementDraftRef.current = externalPlacement;
    if (externalPlacement === null) return;
    const current = draftRef.current;
    if (current !== null && !samePlacement(current.placement, externalPlacement)) {
      const next = { ...current, placement: externalPlacement };
      draftRef.current = next;
      setDraft(next);
    }
  }, [placementDraft]);
  useEffect(() => {
    if (boardStyle !== undefined) void loadBingoStyle(boardStyle).catch(() => undefined);
  }, [boardStyle]);

  const applyBoard = useCallback((nextBoard: BingoBoardState, nextUpdate = updateFromBoard(nextBoard), syncDraft = false, submittedDraft?: BingoCardDraft): void => {
    const current = boardRef.current;
    const reconciledBoard = mergeBoardRevisions(current, nextBoard);
    const responseCardIsCurrent = current === null || nextBoard.cardRevision >= current.cardRevision;
    const currentDraft = draftRef.current;
    const currentSettingsDraft = settingsDraftRef.current;
    const editorWasClean = current === null || sameDraft(currentDraft, currentDraft ?? draftFromBoard(current), current);
    const draftMatchesBoard = currentDraft !== null && sameDraft(currentDraft, currentDraft, reconciledBoard);
    const settingsWereClean = current === null || currentSettingsDraft === null
      || JSON.stringify(currentSettingsDraft) === JSON.stringify(current.settings);
    const settingsMatchBoard = currentSettingsDraft !== null
      && JSON.stringify(currentSettingsDraft) === JSON.stringify(reconciledBoard.settings);
    boardRef.current = reconciledBoard;
    setBoard(reconciledBoard);
    if (settingsWereClean || settingsMatchBoard) {
      settingsDraftRef.current = reconciledBoard.settings;
      setSettingsDraft(reconciledBoard.settings);
      draftBaseSettingsRevisionRef.current = reconciledBoard.settingsRevision;
      setSettingsConflicted(false);
    } else if (reconciledBoard.settingsRevision > current.settingsRevision) {
      setSettingsConflicted(true);
      setError("Die Bingo-Darstellung wurde parallel geändert. Dein Entwurf bleibt erhalten.");
      setMessage("");
    }
    if ((syncDraft && responseCardIsCurrent) || editorWasClean || draftMatchesBoard) {
      const externalPlacement = placementDraftRef.current;
      const draggedPlacement = syncDraft ? null : localPlacementDraft(externalPlacement, current, reconciledBoard);
      const postSubmitEdits = syncDraft && submittedDraft !== undefined && currentDraft !== null
        ? {
          ...(currentDraft.title === submittedDraft.title ? {} : { title: currentDraft.title }),
          ...(currentDraft.size === submittedDraft.size ? {} : { size: currentDraft.size }),
          ...(JSON.stringify(currentDraft.cells) === JSON.stringify(submittedDraft.cells) ? {} : { cells: currentDraft.cells }),
          ...(samePlacement(currentDraft.placement, submittedDraft.placement) ? {} : { placement: currentDraft.placement }),
        }
        : {};
      const nextDraft = {
        ...draftFromBoard(reconciledBoard),
        ...postSubmitEdits,
        ...(draggedPlacement === null ? {} : { placement: draggedPlacement }),
      };
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      draftBaseCardRevisionRef.current = reconciledBoard.cardRevision;
      setConflicted(false);
      setError("");
      onPlacementDraftChange?.(nextDraft.placement);
    } else if (reconciledBoard.cardRevision > current.cardRevision) {
      setConflicted(true);
      setError("Die Bingo-Karte wurde parallel geändert. Dein Entwurf bleibt erhalten.");
      setMessage("");
    }
    onBoardUpdate(nextUpdate.board === reconciledBoard ? nextUpdate : { ...nextUpdate, board: reconciledBoard });
  }, [onBoardUpdate, onPlacementDraftChange]);

  const showError = useCallback((caught: unknown, fallback: string): void => {
    const errorValue = typeof caught === "object" && caught !== null ? caught as { message?: unknown; code?: unknown; currentSnapshot?: unknown } : {};
    const current = errorValue.code === "revision_conflict" ? responseBoard(errorValue.currentSnapshot) : null;
    const baseCardRevision = draftBaseCardRevisionRef.current ?? boardRef.current?.cardRevision ?? current?.cardRevision ?? 0;
    if (current !== null && current.cardRevision > baseCardRevision) setConflicted(true);
    const baseSettingsRevision = draftBaseSettingsRevisionRef.current ?? boardRef.current?.settingsRevision ?? current?.settingsRevision ?? 1;
    if (current !== null && current.settingsRevision > baseSettingsRevision) setSettingsConflicted(true);
    const latest = boardRef.current;
    if (current !== null && (latest === null || (
      current.cardRevision >= latest.cardRevision
      && current.markRevision >= latest.markRevision
      && current.settingsRevision >= latest.settingsRevision
    ))) {
      boardRef.current = current;
      setBoard(current);
    }
    setMessage("");
    setError(typeof errorValue.message === "string" ? errorValue.message : fallback);
  }, []);

  const applyMutation = useCallback((result: BingoMutationResponse, syncDraft = false, submittedDraft?: BingoCardDraft): void => {
    applyBoard(result.board, result.update ?? updateFromBoard(result.board), syncDraft, submittedDraft);
    onUndoTargetsChange(result.undoTargets);
  }, [applyBoard, onUndoTargetsChange]);

  useEffect(() => {
    let disposed = false;
    void api.getBingoBoard().then((initial) => {
      if (disposed) return;
      applyBoard(initial);
    }).catch((caught: unknown) => showError(caught, "Bingo-Board konnte nicht geladen werden."))
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [api, applyBoard, showError]);

  const controlledSetList = externalServerSets !== undefined && onServerSetsChange !== undefined;
  useEffect(() => {
    if (controlledSetList || !online) return;
    let disposed = false;
    void api.listBingoSets().then(({ sets }) => { if (!disposed) setServerSets(sets); }).catch(() => undefined);
    return () => { disposed = true; };
  }, [api, controlledSetList, online, setServerSets]);

  useEffect(() => {
    if (update === null) return;
    const current = boardRef.current;
    if (current !== null && update.board.cardRevision <= current.cardRevision
      && update.board.markRevision <= current.markRevision
      && update.board.settingsRevision <= current.settingsRevision) return;
    const incomingBoard = mergeBoardRevisions(current, update.board);
    const localDraft = draftRef.current;
    const wasDirty = current !== null && !sameDraft(localDraft, localDraft ?? draftFromBoard(current), current);
    const draftMatchesUpdate = localDraft !== null && sameDraft(localDraft, localDraft, incomingBoard);
    const localSettingsDraft = settingsDraftRef.current;
    const settingsWereDirty = current !== null && localSettingsDraft !== null
      && JSON.stringify(localSettingsDraft) !== JSON.stringify(current.settings);
    const settingsMatchUpdate = localSettingsDraft !== null
      && JSON.stringify(localSettingsDraft) === JSON.stringify(incomingBoard.settings);
    boardRef.current = incomingBoard;
    setBoard(incomingBoard);
    if (!settingsWereDirty || settingsMatchUpdate) {
      settingsDraftRef.current = incomingBoard.settings;
      setSettingsDraft(incomingBoard.settings);
      draftBaseSettingsRevisionRef.current = incomingBoard.settingsRevision;
      setSettingsConflicted(false);
    } else if (incomingBoard.settingsRevision > current.settingsRevision) {
      setSettingsConflicted(true);
      setError("Die Bingo-Darstellung wurde parallel geändert. Dein Entwurf bleibt erhalten.");
      setMessage("");
    }
    if (!wasDirty || draftMatchesUpdate) {
      const externalPlacement = placementDraftRef.current;
      const draggedPlacement = localPlacementDraft(externalPlacement, current, incomingBoard);
      const nextDraft = {
        ...draftFromBoard(incomingBoard),
        ...(draggedPlacement === null ? {} : { placement: draggedPlacement }),
      };
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      draftBaseCardRevisionRef.current = incomingBoard.cardRevision;
      setConflicted(false);
      setError("");
      setMessage("");
      onPlacementDraftChange?.(nextDraft.placement);
    } else if (incomingBoard.cardRevision > current.cardRevision) {
      setConflicted(true);
      setError("Die Bingo-Karte wurde parallel geändert. Dein Entwurf bleibt erhalten.");
      setMessage("");
    }
  }, [onPlacementDraftChange, update]);

  const changeDraft = (next: BingoCardDraft): void => {
    const current = draftRef.current;
    const externalPlacement = placementDraftRef.current;
    const preserveDraggedPlacement = current !== null && externalPlacement !== null
      && samePlacement(next.placement, current.placement)
      && !samePlacement(current.placement, externalPlacement);
    const placement = preserveDraggedPlacement ? externalPlacement : next.placement;
    const withPlacement = { ...next, placement };
    draftRef.current = withPlacement;
    setDraft(withPlacement);
    onPlacementDraftChange?.(placement);
    if (!conflicted) setError("");
    setMessage("");
  };

  const changeSettings = (next: BingoPresentationSettings): void => {
    settingsDraftRef.current = next;
    setSettingsDraft(next);
    if (!settingsConflicted) setError("");
    setMessage("");
  };

  const processMarkCell = async (cellId: string, marked: boolean, wasQueued: boolean): Promise<void> => {
    const current = boardRef.current;
    if (current === null || !online || resettingMarksRef.current) return;
    const expectedMarkRevision = current.markRevision;
    try {
      applyMutation(await api.markBingoCell({ cellId, marked, expectedMarkRevision }));
      return;
    } catch (caught) {
      const errorValue = typeof caught === "object" && caught !== null
        ? caught as { code?: unknown; currentSnapshot?: unknown }
        : {};
      if (errorValue.code !== "revision_conflict") {
        showError(caught, "Bingo-Feld konnte nicht geändert werden.");
        return;
      }
      const freshBoard = responseBoard(errorValue.currentSnapshot);
      if (!wasQueued) {
        if (freshBoard !== null) applyBoard(freshBoard);
        showError(caught, "Bingo-Feld konnte nicht geändert werden.");
        return;
      }

      if (freshBoard !== null) applyBoard(freshBoard);
      const latest = boardRef.current;
      if (latest?.marks.includes(cellId) === marked) return;
      if (latest === null || latest.markRevision <= expectedMarkRevision) {
        showError(caught, "Bingo-Feld konnte nicht geändert werden.");
        return;
      }

      try {
        applyMutation(await api.markBingoCell({ cellId, marked, expectedMarkRevision: latest.markRevision }));
      } catch (retryError) {
        const retryValue = typeof retryError === "object" && retryError !== null
          ? retryError as { currentSnapshot?: unknown }
          : {};
        const retryBoard = responseBoard(retryValue.currentSnapshot);
        if (retryBoard !== null) applyBoard(retryBoard);
        showError(retryError, "Bingo-Feld konnte nicht geändert werden.");
      }
    }
  };

  const markCell = (cellId: string, marked: boolean): void => {
    if (boardRef.current === null || !online || resettingMarksRef.current) return;
    setError("");
    setMessage("");
    setMarkPending(true);
    const wasQueued = markQueueRef.current.hasWork;
    void markQueueRef.current.enqueue(() => processMarkCell(cellId, marked, wasQueued)).then(() => {
      if (!markQueueRef.current.hasWork) setMarkPending(false);
    }, () => {
      if (!markQueueRef.current.hasWork) setMarkPending(false);
    });
  };

  const changeStyle = async (style: BingoStyleId): Promise<void> => {
    const current = boardRef.current;
    if (current === null || current.style === style || busy || !online || conflicted || dirty) return;
    setBusySync(true);
    setError("");
    setMessage("");
    try {
      applyMutation(await api.setBingoStyle(style, current.cardRevision));
      setMessage("Bingo-Stil geändert.");
    } catch (caught) {
      showError(caught, "Bingo-Stil konnte nicht geändert werden.");
    } finally {
      setBusySync(false);
    }
  };

  const resetMarks = async (): Promise<void> => {
    const current = boardRef.current;
    if (current === null || busyRef.current || resettingMarksRef.current || !online || !window.confirm("Alle Bingo-Kreuze zurücksetzen?")) return;
    resettingMarksRef.current = true;
    setResettingMarks(true);
    markQueueRef.current.pauseAndClear();
    setError("");
    setMessage("");
    try {
      await markQueueRef.current.waitForActive();
      const latest = boardRef.current;
      if (latest === null) return;
      setBusySync(true);
      try {
        applyMutation(await api.resetBingoMarks(latest.markRevision));
        setMessage("Alle Bingo-Kreuze wurden zurückgesetzt.");
      } catch (caught) {
        showError(caught, "Die Bingo-Kreuze konnten nicht zurückgesetzt werden.");
      } finally {
        setBusySync(false);
      }
    } finally {
      resettingMarksRef.current = false;
      setResettingMarks(false);
      void markQueueRef.current.resume().then(() => {
        if (!markQueueRef.current.hasWork) setMarkPending(false);
      });
    }
  };

  const saveCard = async (): Promise<BingoAdminSaveOutcome> => {
    const current = boardRef.current;
    const editing = draftRef.current;
    if (current === null || editing === null || busyRef.current || !online || conflicted) {
      return { ok: false, conflict: false, message: "Nicht speicherbar." };
    }
    setBusySync(true);
    setError("");
    setMessage("");
    try {
      const submittedDraft = { ...editing, placement: effectivePlacement ?? editing.placement };
      const result = await api.saveBingoCard({ ...submittedDraft, expectedCardRevision: draftBaseCardRevisionRef.current ?? current.cardRevision });
      applyMutation(result, true, submittedDraft);
      setMessage(`Karte gespeichert · Revision ${String(result.board.cardRevision)}.`);
      return { ok: true, conflict: false };
    } catch (caught) {
      const errorValue = typeof caught === "object" && caught !== null ? caught as { message?: unknown; code?: unknown } : {};
      const messageText = typeof errorValue.message === "string" ? errorValue.message : "Die Bingo-Karte konnte nicht gespeichert werden.";
      showError(caught, "Die Bingo-Karte konnte nicht gespeichert werden.");
      return { ok: false, conflict: errorValue.code === "revision_conflict", message: messageText };
    } finally {
      setBusySync(false);
    }
  };

  const saveSettings = async (): Promise<BingoAdminSaveOutcome> => {
    const current = boardRef.current;
    const editing = settingsDraftRef.current;
    if (current === null || editing === null || busyRef.current || !online || settingsConflicted) {
      return { ok: false, conflict: false, message: "Nicht speicherbar." };
    }
    if (JSON.stringify(editing) === JSON.stringify(current.settings)) return { ok: true, conflict: false };
    setBusySync(true);
    setError("");
    setMessage("");
    try {
      const result = await api.saveBingoSettings({
        baseSettingsRevision: draftBaseSettingsRevisionRef.current ?? current.settingsRevision,
        settings: editing,
      });
      applyMutation(result);
      setMessage(`Darstellung gespeichert · Revision ${String(result.board.settingsRevision)}.`);
      return { ok: true, conflict: false };
    } catch (caught) {
      const errorValue = typeof caught === "object" && caught !== null ? caught as { message?: unknown; code?: unknown } : {};
      const messageText = typeof errorValue.message === "string" ? errorValue.message : "Die Bingo-Darstellung konnte nicht gespeichert werden.";
      showError(caught, "Die Bingo-Darstellung konnte nicht gespeichert werden.");
      return { ok: false, conflict: errorValue.code === "revision_conflict", message: messageText };
    } finally {
      setBusySync(false);
    }
  };

  useEffect(() => { saveCardRef.current = saveCard; });
  useEffect(() => { saveSettingsRef.current = saveSettings; });
  useEffect(() => {
    onSaveHandleChange?.({ dirty, save: () => saveCardRef.current() });
  }, [dirty, onSaveHandleChange]);
  useEffect(() => {
    onSettingsHandleChange?.({ dirty: settingsDirty, save: () => saveSettingsRef.current() });
  }, [onSettingsHandleChange, settingsDirty]);

  const loadSet = async (setId: string): Promise<void> => {
    const current = boardRef.current;
    if (current === null || setId === "" || busy || !online) return;
    if (dirty && !window.confirm("Den ungespeicherten Entwurf durch dieses Set ersetzen?")) return;
    setBusySync(true);
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
      setBusySync(false);
    }
  };

  const saveSet = async (): Promise<void> => {
    if (setName.trim() === "" || busy || !online || dirty || renamingSet) return;
    const normalizedName = setName.normalize("NFC").trim().toLocaleLowerCase("de-DE");
    const duplicateUserSet = serverSets.find((set) => set.type === "user" && set.name.normalize("NFC").trim().toLocaleLowerCase("de-DE") === normalizedName);
    const duplicateTemplate = serverSets.find((set) => set.type === "template" && set.name.normalize("NFC").trim().toLocaleLowerCase("de-DE") === normalizedName);
    if (duplicateUserSet !== undefined && !window.confirm(`Set „${duplicateUserSet.name}“ überschreiben?`)) return;
    if (duplicateUserSet === undefined && duplicateTemplate !== undefined) {
      setError("Bingo-Vorlagen können nicht überschrieben werden. Bitte wähle einen anderen Namen.");
      setMessage("");
      return;
    }
    const startingSetList = serverSetsRef.current;
    setBusySync(true);
    setError("");
    setMessage("");
    try {
      const saved = duplicateUserSet === undefined
        ? await api.saveBingoSet(setName.trim())
        : await api.saveBingoSet(setName.trim(), duplicateUserSet.id);
      if (serverSetsRef.current === startingSetList) {
        setServerSets((sets) => sets === startingSetList
          ? [...sets.filter((set) => set.id !== saved.summary.id), saved.summary]
          : sets);
        setSelectedSet(saved.summary.id);
      } else {
        setSelectedSet(serverSetsRef.current.some((set) => set.id === saved.summary.id) ? saved.summary.id : "");
      }
      setSetName("");
      setMessage("Bingo-Set gespeichert.");
    } catch (caught) {
      showError(caught, "Bingo-Set konnte nicht gespeichert werden.");
    } finally {
      setBusySync(false);
    }
  };

  const beginRenameSet = (): void => {
    const selected = serverSets.find((set) => set.id === selectedSet);
    if (selected === undefined || busy || !online) return;
    setRenameName(selected.name);
    setRenamingSetId(selected.id);
    setRenamingSet(true);
    setError("");
    setMessage("");
  };

  const cancelRenameSet = (): void => {
    setRenamingSet(false);
    setRenamingSetId(null);
    setRenameName("");
  };

  const saveRenameSet = async (): Promise<void> => {
    const selected = serverSets.find((set) => set.id === renamingSetId);
    const trimmedName = renameName.normalize("NFC").trim();
    if (selected === undefined || busy || !online) return;
    if (trimmedName === "") {
      setError("Set-Name muss 1–24 Zeichen lang sein.");
      setMessage("");
      return;
    }
    const startingSetList = serverSetsRef.current;
    setBusySync(true);
    setError("");
    setMessage("");
    try {
      const renamed = await api.renameBingoSet(selected.id, trimmedName);
      if (serverSetsRef.current === startingSetList) {
        setServerSets((sets) => sets === startingSetList
          ? sets.map((set) => set.id === renamed.summary.id ? renamed.summary : set)
          : sets);
        setSelectedSet(renamed.summary.id);
      } else {
        setSelectedSet(serverSetsRef.current.some((set) => set.id === renamed.summary.id) ? renamed.summary.id : "");
      }
      setMessage("Bingo-Set umbenannt.");
      setRenamingSet(false);
      setRenamingSetId(null);
      setRenameName("");
    } catch (caught) {
      showError(caught, "Bingo-Set konnte nicht umbenannt werden.");
    } finally {
      setBusySync(false);
    }
  };

  const deleteSet = async (): Promise<void> => {
    const selected = serverSets.find((set) => set.id === selectedSet);
    if (selected?.type !== "user" || busy || !online || renamingSet || !window.confirm(`Set „${selected.name}“ löschen?`)) return;
    const startingSetList = serverSetsRef.current;
    setBusySync(true);
    setError("");
    setMessage("");
    try {
      await api.deleteBingoSet(selected.id);
      if (serverSetsRef.current === startingSetList) {
        setServerSets((sets) => sets === startingSetList ? sets.filter((set) => set.id !== selected.id) : sets);
      }
      setSelectedSet("");
      setMessage("Bingo-Set gelöscht.");
    } catch (caught) {
      showError(caught, "Bingo-Set konnte nicht gelöscht werden.");
    } finally {
      setBusySync(false);
    }
  };

  const importFile = async (file: File | undefined): Promise<void> => {
    const current = boardRef.current;
    if (file === undefined || current === null || busy || !online) return;
    setBusySync(true);
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
      setBusySync(false);
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
    }
  };

  const exportCard = async (): Promise<void> => {
    const current = boardRef.current;
    if (current === null || busy) return;
    setBusySync(true);
    setError("");
    setMessage("");
    try {
      downloadFile(await api.exportBingoCard(), fileNameFor(current.card.title));
      setMessage("Bingo-Karte exportiert.");
    } catch (caught) {
      showError(caught, "Bingo-Karte konnte nicht exportiert werden.");
    } finally {
      setBusySync(false);
    }
  };

  const undo = async (target: UndoTarget): Promise<void> => {
    const current = boardRef.current;
    if (api.undo === undefined || current === null || busy || !online) return;
    if (!window.confirm(`Bingo-Zustand aus Kanalsequenz ${String(target.channelSeq)} wiederherstellen?`)) return;
    setBusySync(true);
    setError("");
    setMessage("");
    try {
      const result = await api.undo("bingo", target.channelSeq, {
        cardRevision: current.cardRevision,
        markRevision: current.markRevision,
        generation: current.generation,
        style: current.style,
        settingsRevision: current.settingsRevision,
      });
      const restored = bingoBoardStateSchema.parse(result.board);
      applyBoard(restored);
      onUndoTargetsChange(result.undoTargets);
      setMessage("Der Bingo-Zustand wurde wiederhergestellt.");
    } catch (caught) {
      showError(caught, "Bingo-Undo fehlgeschlagen.");
    } finally {
      setBusySync(false);
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
    draftBaseSettingsRevisionRef.current = current.settingsRevision;
    settingsDraftRef.current = current.settings;
    setSettingsDraft(current.settings);
    setDraft(nextDraft);
    setConflicted(false);
    setSettingsConflicted(false);
    setError("");
    setMessage("Aktuelle Bingo-Karte geladen.");
    onPlacementDraftChange?.(nextDraft.placement);
  };

  return (
    <section aria-busy={busy || markPending || loading} className="bingo-admin-panel">
      <header className="bingo-admin-heading">
        <div><span className="eyebrow">Bingo-Modul</span><h1>Bingo</h1></div>
        <span className={`bingo-admin-connection ${online ? "is-online" : "is-offline"}`}><i aria-hidden="true" />{online ? "Live verbunden" : "Offline"}</span>
      </header>

      <div aria-live="polite" className={`bingo-admin-message-slot ${conflicted || settingsConflicted || error !== "" ? "has-error" : message !== "" || markPending ? "has-message" : ""}`}>
        {conflicted || settingsConflicted ? <>
          <span role="alert">{error || "Die Bingo-Karte wurde parallel geändert. Dein Entwurf bleibt erhalten."}</span>
          {board !== null && <button className="button button--quiet bingo-admin-message-action" onClick={takeServerCard} type="button">Aktuelle Karte übernehmen</button>}
        </> : error !== "" ? <span role="alert">{error}</span> : markPending ? <span>Bingo-Kreuz wird übernommen …</span> : message !== "" ? <span>{message}</span> : dirty ? <span>Stil erst nach dem Speichern des Kartenentwurfs ändern.</span> : settingsDirty ? <span>Darstellungsentwurf ungespeichert.</span> : <span aria-hidden="true">&nbsp;</span>}
      </div>

      <section aria-labelledby="bingo-live-heading" className="bingo-admin-live-card">
        <div className="bingo-admin-section-heading">
          <div><span className="eyebrow">Regie</span><h2 id="bingo-live-heading">Kartenkachel</h2></div>
          <button className="button button--quiet" disabled={board === null || busy || resettingMarks || !online} onClick={() => void resetMarks()} type="button">Kreuze zurücksetzen</button>
        </div>
        <div className="bingo-admin-board-slot">
          {board === null
            ? <div aria-hidden="true" className="bingo-admin-card-placeholder" />
            : <BingoBoard board={settingsDraft === null ? board : { ...board, settings: settingsDraft }} {...(resettingMarks ? {} : { onToggleCell: (cellId: string, marked: boolean) => markCell(cellId, marked) })} textSizeFactor={1} width={350} />}
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

        <section aria-label="Bingo-Darstellung" className="bingo-admin-settings">
          <fieldset disabled={settingsDraft === null || busy || !online || settingsConflicted}>
            <legend>Schnelleinstellungen</legend>
            <div className="bingo-admin-settings-grid">
              <label><span>Hintergrund <output>{settingsDraft?.backgroundOpacity ?? 100} %</output></span><select aria-label="Hintergrund" onChange={(event) => { if (settingsDraft !== null) changeSettings({ ...settingsDraft, backgroundOpacity: Number(event.currentTarget.value) as BingoPresentationSettings["backgroundOpacity"] }); }} value={settingsDraft?.backgroundOpacity ?? 100}>{[100, 75, 50, 25, 0].map((value) => <option key={value} value={value}>{value} %</option>)}</select></label>
              <label><span>Textgröße <output>{Math.round((settingsDraft?.textScale ?? 1) * 100)} %</output></span><input aria-label="Textgröße" max={2} min={0.75} onChange={(event) => { if (settingsDraft !== null) changeSettings({ ...settingsDraft, textScale: Number(event.currentTarget.value) }); }} step={0.05} type="range" value={settingsDraft?.textScale ?? 1} /></label>
              <label><span>Quellengröße <output>{Math.round((effectivePlacement?.scale ?? 1) * 100)} %</output></span><input aria-label="Quellengröße" max={2} min={0.75} onChange={(event) => { if (draft !== null) changeDraft({ ...draft, placement: { ...placement, scale: Number(event.currentTarget.value) } }); }} step={0.05} type="range" value={effectivePlacement?.scale ?? draft?.placement.scale ?? placement.scale} /></label>
            </div>
          </fieldset>
          <fieldset disabled={settingsDraft === null || busy || !online || settingsConflicted}>
            <legend>Schrift</legend>
            <div className="bingo-admin-settings-grid">
              <label><span>Schriftart</span><select aria-label="Schriftart" onChange={(event) => { if (settingsDraft !== null) changeSettings({ ...settingsDraft, fontFamily: event.currentTarget.value as BingoPresentationSettings["fontFamily"] }); }} value={settingsDraft?.fontFamily ?? "theme"}><option value="theme">Wie Theme</option><option value="atkinson">Atkinson Hyperlegible</option><option value="serif">Serif</option><option value="sans">Sans</option><option value="mono">Mono</option></select></label>
              <label><span>Schrifteffekt</span><select aria-label="Schrifteffekt" onChange={(event) => { if (settingsDraft !== null) changeSettings({ ...settingsDraft, textEmphasis: event.currentTarget.value as BingoPresentationSettings["textEmphasis"] }); }} value={settingsDraft?.textEmphasis ?? "auto"}><option value="auto">automatisch</option><option value="strong">kräftig (fett + Schatten)</option><option value="plain">schlicht</option></select></label>
            </div>
          </fieldset>
          <fieldset disabled={settingsDraft === null || busy || !online || settingsConflicted}>
            <legend>Animationen und Töne</legend>
            <div className="bingo-admin-settings-grid">
              <label><span>Zeremonie</span><select aria-label="Zeremonie" onChange={(event) => { if (settingsDraft !== null) changeSettings({ ...settingsDraft, ceremonyMode: event.currentTarget.value as BingoPresentationSettings["ceremonyMode"] }); }} value={settingsDraft?.ceremonyMode ?? "on"}><option value="on">an</option><option value="subtle">dezent</option><option value="off">aus</option></select></label>
              <label className="bingo-admin-toggle"><input aria-label="Ton bei Linie" checked={settingsDraft?.soundOnLine ?? false} onChange={(event) => { if (settingsDraft !== null) changeSettings({ ...settingsDraft, soundOnLine: event.currentTarget.checked }); }} type="checkbox" /><span>Ton bei Linie</span></label>
              <label className="bingo-admin-toggle"><input aria-label="Ton bei voller Karte" checked={settingsDraft?.soundOnFullCard ?? false} onChange={(event) => { if (settingsDraft !== null) changeSettings({ ...settingsDraft, soundOnFullCard: event.currentTarget.checked }); }} type="checkbox" /><span>Ton bei voller Karte</span></label>
            </div>
          </fieldset>
          <fieldset disabled={settingsDraft === null || busy || !online || settingsConflicted}>
            <legend>Titel &amp; BINGO</legend>
            <div className="bingo-admin-settings-grid">
              <label className="bingo-admin-toggle"><input aria-label="Kartentitel anzeigen" checked={settingsDraft?.showTitle ?? true} onChange={(event) => { if (settingsDraft !== null) changeSettings({ ...settingsDraft, showTitle: event.currentTarget.checked }); }} type="checkbox" /><span>Kartentitel anzeigen</span></label>
              <label className="bingo-admin-toggle"><input aria-label="BINGO anzeigen" checked={settingsDraft?.showBingo ?? true} onChange={(event) => { if (settingsDraft !== null) changeSettings({ ...settingsDraft, showBingo: event.currentTarget.checked }); }} type="checkbox" /><span>BINGO anzeigen</span></label>
            </div>
          </fieldset>
        </section>

        <div className="bingo-admin-set-tools">
          <div className="bingo-admin-set-select-row">
            <label className="bingo-admin-set-select"><span>Vorlage oder gespeichertes Set</span><select disabled={busy || !online || board === null || renamingSet} onChange={(event) => { setSelectedSet(event.currentTarget.value); void loadSet(event.currentTarget.value); }} value={selectedSet}><option value="">Set laden …</option>{serverSets.map((set) => <option key={set.id} value={set.id}>{set.type === "template" ? "Vorlage · " : "Gespeichert · "}{set.name}</option>)}</select></label>
            <button aria-label="Set umbenennen" className="button button--quiet bingo-admin-rename-trigger" disabled={selectedSetRecord === undefined || busy || !online || renamingSet} onClick={beginRenameSet} title="Set umbenennen" type="button"><Pencil size={15} /></button>
          </div>
          <div className="bingo-admin-rename-slot">
            {renamingSet ? <form className="bingo-admin-rename-form" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelRenameSet(); } }} onSubmit={(event) => { event.preventDefault(); void saveRenameSet(); }}>
              <input aria-label="Neuer Setname" autoFocus maxLength={24} onChange={(event) => setRenameName(event.currentTarget.value)} type="text" value={renameName} />
              <button className="button button--quiet" disabled={busy || !online} type="submit"><Check size={15} /> Speichern</button>
              <button className="button button--quiet" disabled={busy} onClick={cancelRenameSet} type="button"><X size={15} /> Abbrechen</button>
            </form> : <span aria-hidden="true">&nbsp;</span>}
          </div>
          <label><span>Als Set speichern</span><input disabled={busy || !online || dirty || renamingSet} maxLength={24} onChange={(event) => setSetName(event.currentTarget.value)} placeholder="Name des Sets" type="text" value={setName} /></label>
          <button className="button button--quiet" disabled={setName.trim() === "" || dirty || busy || !online || renamingSet} onClick={() => void saveSet()} type="button">Set speichern</button>
          <button className="button button--quiet" disabled={selectedSetRecord?.type !== "user" || busy || !online || renamingSet} onClick={() => void deleteSet()} type="button"><Trash2 size={15} /> Set löschen</button>
          <input accept="application/json,.json" aria-label="Bingo-Karte importieren" hidden onChange={(event) => void importFile(event.currentTarget.files?.[0])} ref={fileInputRef} type="file" />
          <button className="button button--quiet" disabled={busy || !online} onClick={() => fileInputRef.current?.click()} type="button"><Upload size={15} /> Importieren</button>
          <button className="button button--quiet" disabled={board === null || busy} onClick={() => void exportCard()} type="button"><Download size={15} /> Karte exportieren</button>
        </div>

        <div className="bingo-admin-placement" aria-label="Bingo-Platzierung">
          <label><span>Platzierung X</span><input disabled={draft === null || busy || !online} max={384} min={0} onChange={(event) => { if (draft !== null) changeDraft({ ...draft, placement: { ...placement, x: Number(event.currentTarget.value) } }); }} type="number" value={effectivePlacement?.x ?? draft?.placement.x ?? placement.x} /></label>
          <label><span>Platzierung Y</span><input disabled={draft === null || busy || !online} max={216} min={0} onChange={(event) => { if (draft !== null) changeDraft({ ...draft, placement: { ...placement, y: Number(event.currentTarget.value) } }); }} type="number" value={effectivePlacement?.y ?? draft?.placement.y ?? placement.y} /></label>
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
