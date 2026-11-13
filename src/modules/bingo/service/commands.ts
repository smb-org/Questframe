import { auditEntrySchema, type AuditEntry } from "../../../shared/contracts/api";
import {
  bingoBoardStateSchema,
  bingoCardSaveRequestSchema,
  bingoSettingsSaveRequestSchema,
  bingoStyleRequestSchema,
  markCellPayloadSchema,
  resetMarksPayloadSchema,
  type BingoBoardState,
  type BingoPresentationSettings,
  type BingoUpdateMessage,
} from "../contracts/schemas";
import { newlyCompleted, type NewlyCompletedResult } from "../domain/lines";
import {
  BingoNotFoundError,
  BingoRevisionConflictError,
  BingoValidationError,
  type BingoRepository,
  type BingoRepositoryTransaction,
  type BingoSetRecord,
} from "../repository/bingo-repository";

export type BingoActor = {
  twitchUserId: string;
  displayName: string;
};

export type BingoServiceOptions = {
  repository: BingoRepository;
  actor: BingoActor;
  clock?: () => string;
};

export type BingoCommandResult = {
  board: BingoBoardState;
  update: BingoUpdateMessage | null;
  ceremony: NewlyCompletedResult | null;
  auditEntry: AuditEntry | null;
};

const createAudit = (
  board: BingoBoardState,
  actor: BingoActor,
  action: AuditEntry["action"],
  summary: string,
  createdAt: string,
): AuditEntry => auditEntrySchema.parse({
  id: crypto.randomUUID(),
  revision: Math.max(board.cardRevision, board.markRevision, board.settingsRevision, 1),
  action,
  actor,
  summary,
  createdAt,
});

const createUpdate = (
  board: BingoBoardState,
  ceremony?: NewlyCompletedResult,
): BingoUpdateMessage => ({
  type: "bingo_update",
  board,
  ...(ceremony === undefined ? {} : {
    ceremony: {
      lines: ceremony.lines,
      fullCard: ceremony.fullCard,
    },
  }),
});

const serializeFailure = (message: string): never => {
  throw new BingoValidationError(message);
};

const requireBoardRevision = (
  board: BingoBoardState,
  expectedRevision: number,
  kind: "card" | "marks" | "settings",
): void => {
  const actualRevision = kind === "card" ? board.cardRevision : kind === "marks" ? board.markRevision : board.settingsRevision;
  if (expectedRevision !== actualRevision) throw new BingoRevisionConflictError(board, kind);
};

const recordBoardMutation = (
  transaction: BingoRepositoryTransaction,
  before: BingoBoardState,
  after: BingoBoardState,
  actor: BingoActor,
  summary: string,
  now: string,
): AuditEntry => {
  transaction.recordHistory(before, summary, now);
  transaction.writeBoard(after, now);
  const auditEntry = createAudit(after, actor, "save", summary, now);
  transaction.recordAudit(auditEntry);
  return auditEntry;
};

export class BingoService {
  private readonly repository: BingoRepository;
  private readonly actor: BingoActor;
  private readonly clock: () => string;

  public constructor(options: BingoServiceOptions) {
    this.repository = options.repository;
    this.actor = options.actor;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  public readBoard(): BingoBoardState {
    return this.repository.readBoard();
  }

  public listSets(): BingoSetRecord["summary"][] {
    return this.repository.listSets();
  }

  public markCell(cellId: string, marked: boolean, expectedMarkRevision: number): BingoCommandResult {
    const input = markCellPayloadSchema.safeParse({ cellId, marked, expectedMarkRevision });
    if (!input.success) return serializeFailure("Ungültige Bingo-Markierung.");

    return this.repository.transaction((transaction) => {
      const before = transaction.readBoard();
      if (!before.card.cells.some((cell) => cell.id === input.data.cellId)) {
        throw new BingoNotFoundError("Bingo-Feld nicht gefunden.");
      }
      // Zielzustand schon erreicht → No-op vor der Revisionsprüfung, damit zwei
      // Mods, die gleichzeitig dasselbe Feld kreuzen, keinen Konflikt sehen.
      // Ein verspäteter Retry nach Undo erreicht den Zustand nicht und scheitert
      // weiter an der Revision.
      const alreadyMarked = before.marks.includes(input.data.cellId);
      if (alreadyMarked === input.data.marked) {
        return { board: before, update: null, ceremony: null, auditEntry: null };
      }
      requireBoardRevision(before, input.data.expectedMarkRevision, "marks");

      const marks = input.data.marked
        ? [...before.marks, input.data.cellId]
        : before.marks.filter((id) => id !== input.data.cellId);
      const after = bingoBoardStateSchema.parse({
        ...before,
        marks,
        markRevision: before.markRevision + 1,
      });
      const completed = newlyCompleted(
        before.marks,
        after.marks,
        before.card.cells.map(({ id }) => id),
        before.card.size,
      );
      const ceremony = completed.lines.length > 0 || completed.fullCard ? completed : null;
      const summary = input.data.marked ? "Bingo-Feld markiert" : "Bingo-Feld abgewählt";
      const now = this.clock();
      const auditEntry = recordBoardMutation(transaction, before, after, this.actor, summary, now);
      return { board: after, update: createUpdate(after, ceremony ?? undefined), ceremony, auditEntry };
    });
  }

  public resetMarks(expectedMarkRevision: number): BingoCommandResult {
    const input = resetMarksPayloadSchema.safeParse({ expectedMarkRevision });
    if (!input.success) return serializeFailure("Ungültige Bingo-Revision.");

    return this.repository.transaction((transaction) => {
      const before = transaction.readBoard();
      requireBoardRevision(before, input.data.expectedMarkRevision, "marks");
      const after = bingoBoardStateSchema.parse({
        ...before,
        marks: [],
        markRevision: before.markRevision + 1,
      });
      const now = this.clock();
      const summary = "Bingo-Kreuze zurückgesetzt";
      const auditEntry = recordBoardMutation(transaction, before, after, this.actor, summary, now);
      return { board: after, update: createUpdate(after), ceremony: null, auditEntry };
    });
  }

  public saveCard(input: {
    title: string;
    size: number;
    cells: BingoBoardState["card"]["cells"];
    placement: BingoBoardState["placement"];
    expectedCardRevision: number;
  }): BingoCommandResult {
    const parsed = bingoCardSaveRequestSchema.safeParse(input);
    if (!parsed.success) return serializeFailure("Ungültige Bingo-Karte.");

    return this.repository.transaction((transaction) => {
      const before = transaction.readBoard();
      requireBoardRevision(before, parsed.data.expectedCardRevision, "card");
      const sizeChanged = parsed.data.size !== before.card.size;
      const availableIds = new Set(parsed.data.cells.map(({ id }) => id));
      const marks = sizeChanged
        ? []
        : before.marks.filter((id) => availableIds.has(id));
      const after = bingoBoardStateSchema.parse({
        ...before,
        card: {
          title: parsed.data.title,
          size: parsed.data.size,
          cells: parsed.data.cells,
        },
        placement: parsed.data.placement,
        marks,
        cardRevision: before.cardRevision + 1,
        markRevision: before.markRevision + 1,
        generation: before.generation + (sizeChanged ? 1 : 0),
      });
      const now = this.clock();
      const auditEntry = recordBoardMutation(
        transaction,
        before,
        after,
        this.actor,
        "Bingo-Karte gespeichert",
        now,
      );
      return { board: after, update: createUpdate(after), ceremony: null, auditEntry };
    });
  }

  public loadSet(setId: string, expectedCardRevision: number): BingoCommandResult {
    return this.repository.transaction((transaction) => {
      const before = transaction.readBoard();
      requireBoardRevision(before, expectedCardRevision, "card");
      const set = transaction.getSet(setId);
      if (set === null) throw new BingoNotFoundError();
      const after = bingoBoardStateSchema.parse({
        ...before,
        card: set.card,
        marks: [],
        cardRevision: before.cardRevision + 1,
        markRevision: before.markRevision + 1,
        generation: before.generation + 1,
      });
      const now = this.clock();
      const auditEntry = recordBoardMutation(
        transaction,
        before,
        after,
        this.actor,
        `Bingo-Set „${set.summary.name}“ geladen`,
        now,
      );
      return { board: after, update: createUpdate(after), ceremony: null, auditEntry };
    });
  }

  public importCard(card: {
    title: string;
    size: number;
    cells: BingoBoardState["card"]["cells"];
  }, expectedCardRevision: number): BingoCommandResult {
    const parsed = bingoCardSaveRequestSchema.safeParse({
      ...card,
      placement: this.repository.readBoard().placement,
      expectedCardRevision,
    });
    if (!parsed.success) return serializeFailure("Ungültige Bingo-Karte.");

    return this.repository.transaction((transaction) => {
      const before = transaction.readBoard();
      requireBoardRevision(before, parsed.data.expectedCardRevision, "card");
      const after = bingoBoardStateSchema.parse({
        ...before,
        card: {
          title: parsed.data.title,
          size: parsed.data.size,
          cells: parsed.data.cells,
        },
        marks: [],
        cardRevision: before.cardRevision + 1,
        markRevision: before.markRevision + 1,
        generation: before.generation + 1,
      });
      const now = this.clock();
      const auditEntry = recordBoardMutation(
        transaction,
        before,
        after,
        this.actor,
        "Bingo-Karte importiert",
        now,
      );
      return { board: after, update: createUpdate(after), ceremony: null, auditEntry };
    });
  }

  public saveSet(name: string, overwriteSetId?: string): BingoSetRecord {
    return this.repository.transaction((transaction) => {
      const board = transaction.readBoard();
      const now = this.clock();
      const set = overwriteSetId === undefined
        ? transaction.createSet(name, board.card, now)
        : transaction.overwriteSet(overwriteSetId, name, board.card, now);
      transaction.recordAudit(createAudit(
        board,
        this.actor,
        "save",
        overwriteSetId === undefined
          ? `Bingo-Set „${set.summary.name}“ gespeichert`
          : `Bingo-Set „${set.summary.name}“ überschrieben`,
        now,
      ));
      return set;
    });
  }

  public renameSet(setId: string, name: string): { set: BingoSetRecord; auditEntry: AuditEntry } {
    return this.repository.transaction((transaction) => {
      const board = transaction.readBoard();
      const now = this.clock();
      const set = transaction.renameSet(setId, name, now);
      const auditEntry = createAudit(board, this.actor, "save", `Bingo-Set „${set.summary.name}“ umbenannt`, now);
      transaction.recordAudit(auditEntry);
      return { set, auditEntry };
    });
  }

  public deleteSet(setId: string): void {
    this.repository.transaction((transaction) => {
      const set = transaction.getSet(setId);
      if (set === null) throw new BingoNotFoundError();
      transaction.deleteSet(setId);
      const now = this.clock();
      const board = transaction.readBoard();
      transaction.recordAudit(createAudit(board, this.actor, "save", `Bingo-Set „${set.summary.name}“ gelöscht`, now));
    });
  }

  public setStyle(style: string, expectedCardRevision: number): BingoCommandResult {
    const parsedStyle = bingoStyleRequestSchema.safeParse({ style, expectedCardRevision });
    if (!parsedStyle.success) return serializeFailure("Ungültiger Bingo-Stil.");

    return this.repository.transaction((transaction) => {
      const before = transaction.readBoard();
      requireBoardRevision(before, parsedStyle.data.expectedCardRevision, "card");
      if (before.style === parsedStyle.data.style) {
        return { board: before, update: null, ceremony: null, auditEntry: null };
      }
      const after = bingoBoardStateSchema.parse({
        ...before,
        style: parsedStyle.data.style,
        cardRevision: before.cardRevision + 1,
      });
      const now = this.clock();
      const auditEntry = recordBoardMutation(
        transaction,
        before,
        after,
        this.actor,
        "Bingo-Stil geändert",
        now,
      );
      return { board: after, update: createUpdate(after), ceremony: null, auditEntry };
    });
  }

  public saveSettings(settings: BingoPresentationSettings, baseSettingsRevision: number): BingoCommandResult {
    const parsed = bingoSettingsSaveRequestSchema.safeParse({ settings, baseSettingsRevision });
    if (!parsed.success) return serializeFailure("Ungültige Bingo-Darstellung.");

    return this.repository.transaction((transaction) => {
      const before = transaction.readBoard();
      requireBoardRevision(before, parsed.data.baseSettingsRevision, "settings");
      if (JSON.stringify(before.settings) === JSON.stringify(parsed.data.settings)) {
        return { board: before, update: null, ceremony: null, auditEntry: null };
      }
      const after = bingoBoardStateSchema.parse({
        ...before,
        settings: parsed.data.settings,
        settingsRevision: before.settingsRevision + 1,
      });
      const now = this.clock();
      const auditEntry = recordBoardMutation(
        transaction,
        before,
        after,
        this.actor,
        "Bingo-Darstellung gespeichert",
        now,
      );
      return { board: after, update: createUpdate(after), ceremony: null, auditEntry };
    });
  }
}

export const createBingoService = (options: BingoServiceOptions): BingoService =>
  new BingoService(options);

export const applyBingoUndo = (
  options: BingoServiceOptions,
  snapshotJson: string,
): BingoCommandResult => {
  let target: unknown;
  try {
    target = JSON.parse(snapshotJson) as unknown;
  } catch {
    throw new BingoValidationError("Bingo-Historie enthält kein gültiges JSON.");
  }
  const parsedTarget = bingoBoardStateSchema.safeParse(target);
  if (!parsedTarget.success) throw new BingoValidationError("Bingo-Historie enthält keinen gültigen Zustand.");

  return options.repository.transaction((transaction) => {
    const before = transaction.readBoard();
    const targetBoard = parsedTarget.data;
    const cardChanged = JSON.stringify(before.card) !== JSON.stringify(targetBoard.card);
    const styleChanged = before.style !== targetBoard.style;
    const placementChanged = JSON.stringify(before.placement) !== JSON.stringify(targetBoard.placement);
    const settingsChanged = JSON.stringify(before.settings) !== JSON.stringify(targetBoard.settings);
    const after = bingoBoardStateSchema.parse({
      ...before,
      card: targetBoard.card,
      marks: targetBoard.marks,
      style: targetBoard.style,
      placement: targetBoard.placement,
      settings: targetBoard.settings,
      settingsRevision: before.settingsRevision + (settingsChanged ? 1 : 0),
      cardRevision: before.cardRevision + (cardChanged || styleChanged || placementChanged ? 1 : 0),
      markRevision: before.markRevision + 1,
      generation: before.generation + (cardChanged ? 1 : 0),
    });
    const now = (options.clock ?? (() => new Date().toISOString()))();
    const summary = "Bingo-Zustand wiederhergestellt";
    transaction.recordHistory(before, summary, now);
    transaction.writeBoard(after, now);
    const auditEntry = createAudit(after, options.actor, "undo", summary, now);
    transaction.recordAudit(auditEntry);
    return { board: after, update: createUpdate(after), ceremony: null, auditEntry };
  });
};
