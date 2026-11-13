import { z } from "zod";

import { auditEntrySchema, type AuditEntry } from "../../../shared/contracts/api";
import {
  MAX_CHALLENGE_SETS,
  isChallengeSetName,
  normalizeChallengeSetName,
} from "../../win-challenges/contracts/predicates";
import {
  bingoBoardStateSchema,
  bingoCardSchema,
  bingoPresentationSettingsSchema,
  type BingoBoardState,
  type BingoCard,
} from "../contracts/schemas";

export type BingoSetType = "template" | "user";

export type BingoSetSummary = {
  id: string;
  type: BingoSetType;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type BingoSetRecord = {
  summary: BingoSetSummary;
  card: BingoCard;
};

export type BingoHistoryEntry = {
  channelSeq: number;
  moduleId: "bingo";
  revision: number;
  snapshotJson: string;
  createdAt: string;
  summary: string;
};

export type BingoRepositoryErrorCode = "not_found" | "revision_conflict" | "validation_failed";

export class BingoRepositoryError extends Error {
  public readonly code: BingoRepositoryErrorCode;

  public constructor(code: BingoRepositoryErrorCode, message: string) {
    super(message);
    this.name = "BingoRepositoryError";
    this.code = code;
  }
}

export class BingoNotFoundError extends BingoRepositoryError {
  public constructor(message = "Bingo-Set nicht gefunden.") {
    super("not_found", message);
    this.name = "BingoNotFoundError";
  }
}

export class BingoValidationError extends BingoRepositoryError {
  public constructor(message: string) {
    super("validation_failed", message);
    this.name = "BingoValidationError";
  }
}

export class BingoRevisionConflictError extends BingoRepositoryError {
  public readonly board: BingoBoardState;

  public constructor(board: BingoBoardState, kind: "card" | "marks" | "settings") {
    super("revision_conflict", kind === "card"
      ? "Die Bingo-Karte wurde inzwischen geändert."
      : kind === "marks"
        ? "Die Bingo-Markierungen wurden inzwischen geändert."
        : "Die Bingo-Darstellung wurde inzwischen geändert.");
    this.name = "BingoRevisionConflictError";
    this.board = board;
  }
}

export interface BingoRepositoryTransaction {
  readBoard(): BingoBoardState;
  writeBoard(board: BingoBoardState, updatedAt: string): void;
  getSet(setId: string): BingoSetRecord | null;
  listSets(): BingoSetSummary[];
  createSet(name: string, card: BingoCard, now: string): BingoSetRecord;
  overwriteSet(setId: string, name: string, card: BingoCard, now: string): BingoSetRecord;
  renameSet(setId: string, name: string, now: string): BingoSetRecord;
  deleteSet(setId: string): void;
  recordHistory(board: BingoBoardState, summary: string, createdAt: string): void;
  recordAudit(entry: AuditEntry): void;
}

export interface BingoRepository {
  transaction<T>(callback: (transaction: BingoRepositoryTransaction) => T): T;
  readBoard(): BingoBoardState;
  getSet(setId: string): BingoSetRecord | null;
  listSets(): BingoSetSummary[];
  createSet(name: string, card: BingoCard, now: string): BingoSetRecord;
  overwriteSet(setId: string, name: string, card: BingoCard, now: string): BingoSetRecord;
  renameSet(setId: string, name: string, now: string): BingoSetRecord;
  deleteSet(setId: string): void;
}

export type SqlStorageBingoRepositoryOptions = {
  sql: SqlStorage;
  transactionSync: <T>(callback: () => T) => T;
};

type BoardRow = {
  singleton: number;
  title: string;
  size: number;
  cells_json: string;
  marks_json: string;
  card_revision: number;
  mark_revision: number;
  generation: number;
  placement_x: number;
  placement_y: number;
  placement_scale: number;
  style: string;
  settings_revision: number;
  settings_json: string;
  created_at: string;
  updated_at: string;
};

type SetRow = {
  id: string;
  type: string;
  name: string;
  normalized_name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  payload: string;
};

const boardRowSchema = z.strictObject({
  singleton: z.literal(1),
  title: z.string(),
  size: z.number().int(),
  cells_json: z.string(),
  marks_json: z.string(),
  card_revision: z.number().int(),
  mark_revision: z.number().int(),
  generation: z.number().int(),
  placement_x: z.number().int(),
  placement_y: z.number().int(),
  placement_scale: z.number(),
  style: z.string(),
  settings_revision: z.number().int(),
  settings_json: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const setRowSchema = z.strictObject({
  id: z.string(),
  type: z.enum(["template", "user"]),
  name: z.string(),
  normalized_name: z.string(),
  sort_order: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  payload: z.string(),
});

const setSummarySchema = z.strictObject({
  id: z.string(),
  type: z.enum(["template", "user"]),
  name: z.string(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const parseJson = (value: string, label: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} ist kein gültiges JSON.`);
  }
};

const summaryFromRow = (row: SetRow): BingoSetSummary => setSummarySchema.parse({
  id: row.id,
  type: row.type,
  name: row.name,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class SqlStorageBingoRepository implements BingoRepository {
  private readonly sql: SqlStorage;
  private readonly transactionSync: <T>(callback: () => T) => T;

  public static create(options: SqlStorageBingoRepositoryOptions): SqlStorageBingoRepository {
    return new SqlStorageBingoRepository(options);
  }

  private constructor(options: SqlStorageBingoRepositoryOptions) {
    this.sql = options.sql;
    this.transactionSync = options.transactionSync;
  }

  public transaction<T>(callback: (transaction: BingoRepositoryTransaction) => T): T {
    return this.transactionSync(() => callback(this.makeTransaction()));
  }

  public readBoard(): BingoBoardState {
    return this.readBoardInternal();
  }

  public getSet(setId: string): BingoSetRecord | null {
    return this.getSetInternal(setId);
  }

  public listSets(): BingoSetSummary[] {
    return this.listSetsInternal();
  }

  public createSet(name: string, card: BingoCard, now: string): BingoSetRecord {
    return this.transaction((transaction) => transaction.createSet(name, card, now));
  }

  public overwriteSet(setId: string, name: string, card: BingoCard, now: string): BingoSetRecord {
    return this.transaction((transaction) => transaction.overwriteSet(setId, name, card, now));
  }

  public renameSet(setId: string, name: string, now: string): BingoSetRecord {
    return this.transaction((transaction) => transaction.renameSet(setId, name, now));
  }

  public deleteSet(setId: string): void {
    this.transaction((transaction) => {
      transaction.deleteSet(setId);
    });
  }

  private makeTransaction(): BingoRepositoryTransaction {
    return {
      readBoard: () => this.readBoardInternal(),
      writeBoard: (board, updatedAt) => {
        this.writeBoardInternal(board, updatedAt);
      },
      getSet: (setId) => this.getSetInternal(setId),
      listSets: () => this.listSetsInternal(),
      createSet: (name, card, now) => this.createSetInternal(name, card, now),
      overwriteSet: (setId, name, card, now) => this.overwriteSetInternal(setId, name, card, now),
      renameSet: (setId, name, now) => this.renameSetInternal(setId, name, now),
      deleteSet: (setId) => {
        this.deleteSetInternal(setId);
      },
      recordHistory: (board, summary, createdAt) => {
        this.recordHistoryInternal(board, summary, createdAt);
      },
      recordAudit: (entry) => {
        this.recordAuditInternal(entry);
      },
    };
  }

  private readBoardInternal(): BingoBoardState {
    const row = this.sql.exec<BoardRow>("SELECT * FROM bg_board WHERE singleton = 1").toArray()[0];
    if (row === undefined) throw new Error("bg_board ist nicht initialisiert.");
    const parsed = boardRowSchema.parse(row);
    return bingoBoardStateSchema.parse({
      card: {
        title: parsed.title,
        size: parsed.size,
        cells: parseJson(parsed.cells_json, "Bingo-Felder"),
      },
      marks: parseJson(parsed.marks_json, "Bingo-Markierungen"),
      cardRevision: parsed.card_revision,
      markRevision: parsed.mark_revision,
      generation: parsed.generation,
      settingsRevision: parsed.settings_revision,
      settings: bingoPresentationSettingsSchema.parse(parseJson(parsed.settings_json, "Bingo-Darstellung")),
      style: parsed.style,
      placement: {
        x: parsed.placement_x,
        y: parsed.placement_y,
        scale: parsed.placement_scale,
      },
    });
  }

  private writeBoardInternal(board: BingoBoardState, updatedAt: string): void {
    const parsed = bingoBoardStateSchema.parse(board);
    this.sql.exec(
      `UPDATE bg_board SET
        title = ?, size = ?, cells_json = ?, marks_json = ?, card_revision = ?, mark_revision = ?,
        generation = ?, placement_x = ?, placement_y = ?, placement_scale = ?, style = ?,
        settings_revision = ?, settings_json = ?, updated_at = ?
       WHERE singleton = 1`,
      parsed.card.title,
      parsed.card.size,
      JSON.stringify(parsed.card.cells),
      JSON.stringify(parsed.marks),
      parsed.cardRevision,
      parsed.markRevision,
      parsed.generation,
      parsed.placement.x,
      parsed.placement.y,
      parsed.placement.scale,
      parsed.style,
      parsed.settingsRevision,
      JSON.stringify(parsed.settings),
      updatedAt,
    );
  }

  private listSetsInternal(): BingoSetSummary[] {
    return this.sql
      .exec<SetRow>(
        "SELECT id, type, name, normalized_name, sort_order, created_at, updated_at, payload FROM bg_sets ORDER BY sort_order ASC, updated_at DESC, id ASC",
      )
      .toArray()
      .map((row) => summaryFromRow(setRowSchema.parse(row)));
  }

  private getSetInternal(setId: string): BingoSetRecord | null {
    const row = this.sql
      .exec<SetRow>("SELECT * FROM bg_sets WHERE id = ?", setId)
      .toArray()[0];
    if (row === undefined) return null;
    const parsed = setRowSchema.parse(row);
    const card = bingoCardSchema.parse(parseJson(parsed.payload, "Bingo-Set"));
    return { summary: summaryFromRow(parsed), card };
  }

  private createSetInternal(name: string, card: BingoCard, now: string): BingoSetRecord {
    const normalizedName = name.normalize("NFC").trim();
    if (!isChallengeSetName(normalizedName)) {
      throw new BingoValidationError("Set-Name muss normalisiert 1–24 Zeichen lang sein.");
    }
    const parsedCard = bingoCardSchema.parse(card);
    const normalizedKey = normalizeChallengeSetName(normalizedName);
    const templateDuplicate = this.sql.exec<{ id: string }>(
      "SELECT id FROM bg_sets WHERE type = 'template' AND normalized_name = ?",
      normalizedKey,
    ).toArray()[0];
    if (templateDuplicate !== undefined) {
      throw new BingoValidationError("Bingo-Vorlagen können nicht überschrieben werden. Bitte wähle einen anderen Namen.");
    }
    const count = this.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM bg_sets WHERE type = 'user'",
    ).toArray()[0]?.count;
    if (count === undefined || count >= MAX_CHALLENGE_SETS) {
      throw new BingoValidationError("Es sind höchstens 20 eigene Bingo-Sets erlaubt.");
    }
    const duplicate = this.sql.exec<{ id: string }>(
      "SELECT id FROM bg_sets WHERE type = 'user' AND normalized_name = ?",
      normalizedKey,
    ).toArray()[0];
    if (duplicate !== undefined) throw new BingoValidationError("Ein Bingo-Set mit diesem Namen gibt es bereits.");

    const sortOrder = this.sql.exec<{ sort_order: number }>(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM bg_sets",
    ).toArray()[0]?.sort_order;
    if (sortOrder === undefined) throw new Error("Bingo-Set-Sortierung konnte nicht vergeben werden.");
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO bg_sets(id, type, name, normalized_name, sort_order, created_at, updated_at, payload)
       VALUES (?, 'user', ?, ?, ?, ?, ?, ?)`,
      id,
      normalizedName,
      normalizedKey,
      sortOrder,
      now,
      now,
      JSON.stringify(parsedCard),
    );
    return {
      summary: {
        id,
        type: "user",
        name: normalizedName,
        sortOrder,
        createdAt: now,
        updatedAt: now,
      },
      card: parsedCard,
    };
  }

  private overwriteSetInternal(setId: string, name: string, card: BingoCard, now: string): BingoSetRecord {
    const normalizedName = name.normalize("NFC").trim();
    if (!isChallengeSetName(normalizedName)) {
      throw new BingoValidationError("Set-Name muss normalisiert 1–24 Zeichen lang sein.");
    }
    const existing = this.getSetInternal(setId);
    if (existing === null) throw new BingoNotFoundError();
    if (existing.summary.type === "template") {
      throw new BingoValidationError("Bingo-Vorlagen können nicht überschrieben werden.");
    }
    if (existing.summary.name.normalize("NFC").trim().toLocaleLowerCase("de-DE")
      !== normalizedName.toLocaleLowerCase("de-DE")) {
      throw new BingoValidationError("Das ausgewählte Bingo-Set hat inzwischen einen anderen Namen.");
    }
    const parsedCard = bingoCardSchema.parse(card);
    this.sql.exec(
      "UPDATE bg_sets SET payload = ?, updated_at = ? WHERE id = ? AND type = 'user'",
      JSON.stringify(parsedCard),
      now,
      setId,
    );
    const updated = this.getSetInternal(setId);
    if (updated === null) throw new BingoNotFoundError();
    return updated;
  }

  private renameSetInternal(setId: string, name: string, now: string): BingoSetRecord {
    const normalizedName = name.normalize("NFC").trim();
    if (!isChallengeSetName(normalizedName)) {
      throw new BingoValidationError("Set-Name muss normalisiert 1–24 Zeichen lang sein.");
    }
    const existing = this.getSetInternal(setId);
    if (existing === null) throw new BingoNotFoundError();
    const normalizedKey = normalizeChallengeSetName(normalizedName);
    const duplicate = this.sql.exec<{ id: string }>(
      "SELECT id FROM bg_sets WHERE type = ? AND normalized_name = ? AND id <> ?",
      existing.summary.type,
      normalizedKey,
      setId,
    ).toArray()[0];
    if (duplicate !== undefined) {
      throw new BingoValidationError(existing.summary.type === "template"
        ? "Eine Bingo-Vorlage mit diesem Namen gibt es bereits."
        : "Ein Bingo-Set mit diesem Namen gibt es bereits.");
    }
    const renamedCard = existing.summary.type === "template" && existing.card.title === existing.summary.name
      ? { ...existing.card, title: normalizedName }
      : existing.card;
    this.sql.exec(
      "UPDATE bg_sets SET name = ?, normalized_name = ?, payload = ?, updated_at = ? WHERE id = ?",
      normalizedName,
      normalizedKey,
      JSON.stringify(renamedCard),
      now,
      setId,
    );
    const renamed = this.getSetInternal(setId);
    if (renamed === null) throw new BingoNotFoundError();
    return renamed;
  }

  private deleteSetInternal(setId: string): void {
    const existing = this.getSetInternal(setId);
    if (existing === null) throw new BingoNotFoundError();
    if (existing.summary.type === "template") {
      throw new BingoValidationError("Bingo-Vorlagen können nicht gelöscht werden.");
    }
    this.sql.exec("DELETE FROM bg_sets WHERE id = ?", setId);
  }

  private recordHistoryInternal(board: BingoBoardState, summary: string, createdAt: string): void {
    const channelSeq = this.sql.exec<{ channel_seq: number }>(
      "SELECT COALESCE(MAX(channel_seq), 0) + 1 AS channel_seq FROM state_history",
    ).toArray()[0]?.channel_seq;
    if (channelSeq === undefined) throw new Error("Kanalsequenz für Bingo-Historie konnte nicht vergeben werden.");
    const parsed = bingoBoardStateSchema.parse(board);
    this.sql.exec(
      `INSERT INTO state_history(channel_seq, module_id, revision, snapshot_json, created_at, summary)
       VALUES (?, 'bingo', ?, ?, ?, ?)`,
      channelSeq,
      Math.max(parsed.cardRevision, parsed.markRevision, parsed.settingsRevision),
      JSON.stringify(parsed),
      createdAt,
      summary,
    );
    this.sql.exec(
      `DELETE FROM state_history WHERE module_id = 'bingo' AND channel_seq NOT IN (
        SELECT channel_seq FROM state_history WHERE module_id = 'bingo' ORDER BY channel_seq DESC LIMIT 20
      )`,
    );
  }

  private recordAuditInternal(entry: AuditEntry): void {
    const parsed = auditEntrySchema.parse(entry);
    this.sql.exec(
      `INSERT INTO audit_log(id, revision, action, actor_id, actor_name, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      parsed.id,
      parsed.revision,
      parsed.action,
      parsed.actor.twitchUserId,
      parsed.actor.displayName,
      parsed.summary,
      parsed.createdAt,
    );
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
    this.sql.exec(
      "DELETE FROM audit_log WHERE created_at < ? OR id NOT IN (SELECT id FROM audit_log ORDER BY created_at DESC LIMIT 500)",
      cutoff,
    );
  }
}

export const createSqlStorageBingoRepository = (
  options: SqlStorageBingoRepositoryOptions,
): SqlStorageBingoRepository => SqlStorageBingoRepository.create(options);
