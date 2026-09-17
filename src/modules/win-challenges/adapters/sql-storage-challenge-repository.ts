import { z } from "zod";

import { allocateControlKey } from "../domain/control-keys";
import {
  challengeDefinitionSchema,
  challengePlacementSchema,
  challengeSchema,
  challengeSetV1Schema,
  globalTimerSchema,
  settingsSchema,
  type Challenge,
  type ChallengeSetSummary,
  type GlobalTimer,
} from "../contracts/schemas";
import {
  MAX_CHALLENGES,
  MAX_CHALLENGE_SETS,
  isCurrentCountForKind,
  isChallengeSetName,
  isDeltaForKind,
  isEventSeq,
  isGlobalTimerMode,
  isGlobalTimerTotalMs,
  isRevision,
  maxCountForKind,
  normalizeChallengeSetName,
} from "../contracts/predicates";
import { mergeDefinition, normalizeSortOrder } from "../domain/definitions";
import { encodeChallengeSet } from "../domain/set-codec";
import type { DomainNow } from "../domain/timers";
import {
  IdempotencyMismatchError,
  NotFoundError,
  RevisionConflictError,
  ValidationError,
  type BoardSaveInput,
  type BoardSaveResult,
  AUTO_SAVE_SET_ID,
  AUTO_SAVE_SET_NAME,
  type ChallengeRepository,
  type ChallengeRepositorySettings,
  type ChallengeRepositoryTransaction,
  type ChallengeRuntime,
  type ChallengeSetRecord,
  type ChallengeSetSaveInput,
  type ChallengeSnapshot,
  type CommandIdentity,
  type CommandMutation,
  type CommandRecord,
  type CommandResult,
  type DockTokenRecord,
  type SettingsSaveInputWithRevision,
  type SettingsSaveResult,
} from "../repository/challenge-repository";

const TABLE_PREFIX = "wc_";
const DAY_MS = 24 * 60 * 60 * 1_000;

type MetaRow = {
  singleton: number;
  event_seq: number;
  board_revision: number;
  settings_revision: number;
  style_id: string;
  theme_mode: string;
  surface_opacity: number;
  header_style: string;
  text_emphasis: string;
  font_family: string;
  font_scale: number;
  header_title: string;
  penalty_label: string;
  penalty_text: string;
  effects_enabled: number;
  max_visible: number;
  overflow_mode: string;
  overflow_tempo: string;
  numbered: number;
  key_visible: number;
  done_order: string;
  global_timer_mode: string;
  placement_x: number;
  placement_y: number;
  placement_scale: number;
  global_timer_total_ms: number | null;
  global_timer_ends_at: string | null;
  global_timer_paused_remain_ms: number | null;
};

type ChallengeRow = {
  id: string;
  title: string;
  kind: string;
  unit: string | null;
  control_key: string;
  target_count: number | null;
  timer_total_ms: number | null;
  sort_order: number;
  step: number;
  best_count: number;
  hidden: number;
  current_count: number;
  state: string;
  timer_ends_at: string | null;
  timer_remain_ms: number | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type CommandRow = {
  command_id: string;
  request_hash: string;
  created_at: string;
};

type DockTokenRow = {
  singleton: number;
  token_hash: string;
  token_envelope: string | null;
  fingerprint: string;
  generation: number;
  request_id: string;
  creating_session_hash: string;
  created_at: string;
  last_used_at: string | null;
};

type ChallengeSetMetadataRow = {
  id: string;
  type: string;
  name: string;
  normalized_name: string;
  has_progress: number;
  created_at: string;
  updated_at: string;
};

type ChallengeSetRow = ChallengeSetMetadataRow & {
  payload: string;
};

const persistedSettingsSchema = settingsSchema;
const metaRowSchema = z.strictObject({
  singleton: z.literal(1),
  event_seq: z.number().int().nonnegative(),
  board_revision: z.number().int().positive(),
  settings_revision: z.number().int().positive(),
  style_id: z.string(),
  theme_mode: z.string(),
  surface_opacity: z.number().int(),
  header_style: z.string(),
  text_emphasis: z.string(),
  font_family: z.string(),
  font_scale: z.number(),
  header_title: z.string(),
  penalty_label: z.string(),
  penalty_text: z.string(),
  effects_enabled: z.number().int(),
  max_visible: z.number().int(),
  overflow_mode: z.string(),
  overflow_tempo: z.string(),
  numbered: z.number().int(),
  key_visible: z.number().int(),
  done_order: z.string(),
  global_timer_mode: z.string(),
  placement_x: z.number().int(),
  placement_y: z.number().int(),
  placement_scale: z.number(),
  global_timer_total_ms: z.union([z.number().int(), z.null()]),
  global_timer_ends_at: z.union([z.string(), z.null()]),
  global_timer_paused_remain_ms: z.union([z.number().int(), z.null()]),
});
const commandRowSchema = z.strictObject({
  command_id: z.string().min(1),
  request_hash: z.string().min(1),
  created_at: z.string().min(1),
});
const dockTokenRowSchema = z.strictObject({
  singleton: z.literal(1),
  token_hash: z.string().min(1),
  token_envelope: z.union([z.string(), z.null()]),
  fingerprint: z.string().min(1),
  generation: z.number().int().nonnegative(),
  request_id: z.string().min(1),
  creating_session_hash: z.string().min(1),
  created_at: z.string().min(1),
  last_used_at: z.union([z.string(), z.null()]),
});
const challengeSetMetadataRowSchema = z.strictObject({
  id: z.string().min(1).max(80),
  type: z.union([z.literal("user"), z.literal("autosave")]),
  name: z.string().min(1).max(80),
  normalized_name: z.string().min(1).max(80),
  has_progress: z.union([z.literal(0), z.literal(1)]),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
const challengeSetRowSchema = challengeSetMetadataRowSchema.extend({
  payload: z.string().min(1),
});
const storedChallengeSetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  challenges: z.array(z.unknown()).max(MAX_CHALLENGES),
});

export type SqlOperationMetrics = {
  rowsRead: number;
  rowsWritten: number;
};

export type MeasuredSqlOperation<T> = SqlOperationMetrics & {
  result: T;
};

type SqlStorageChallengeRepositoryOptions = {
  sql: SqlStorage;
  transactionSync: <T>(callback: () => T) => T;
  tablePrefix: string;
  onDockTokenDeleted?: () => void;
};

const validateTablePrefix = (tablePrefix: string): string => {
  if (tablePrefix.length > 16 || !/^[a-z][a-z0-9_]*$/.test(tablePrefix)) {
    throw new Error("Ungültiges Tabellenpräfix.");
  }
  return tablePrefix;
};

const toMilliseconds = (now: DomainNow): number => {
  const milliseconds = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(milliseconds)) throw new ValidationError("Ungültiger Zeitpunkt.");
  return milliseconds;
};

const toInstant = (now: DomainNow): string => new Date(toMilliseconds(now)).toISOString();

const parseBooleanInteger = (value: number): boolean => {
  const parsed = z.union([z.literal(0), z.literal(1)]).parse(value);
  return parsed === 1;
};

const parseMeta = (row: MetaRow): ChallengeSnapshot["settings"] &
  Pick<ChallengeSnapshot, "eventSeq" | "boardRevision" | "settingsRevision"> => {
  const parsedRow = metaRowSchema.parse(row);
  const globalTimer =
    parsedRow.global_timer_total_ms === null
      ? null
      : globalTimerSchema.parse({
          totalMs: parsedRow.global_timer_total_ms,
          endsAt: parsedRow.global_timer_ends_at,
          pausedRemainMs: parsedRow.global_timer_paused_remain_ms,
        });
  if (
    parsedRow.global_timer_total_ms === null &&
    (parsedRow.global_timer_ends_at !== null || parsedRow.global_timer_paused_remain_ms !== null)
  ) {
    throw new Error("Ungültiger globaler Timer in wc_meta.");
  }
  if (!isEventSeq(parsedRow.event_seq) || !isRevision(parsedRow.board_revision) || !isRevision(parsedRow.settings_revision)) {
    throw new Error("Ungültige Challenge-Revision in wc_meta.");
  }
  const settings = persistedSettingsSchema.parse({
    styleId: parsedRow.style_id,
    themeMode: parsedRow.theme_mode,
    surfaceOpacity: parsedRow.surface_opacity,
    headerStyle: parsedRow.header_style,
    textEmphasis: parsedRow.text_emphasis,
    fontFamily: parsedRow.font_family,
    fontScale: parsedRow.font_scale,
    headerTitle: parsedRow.header_title,
    penaltyLabel: parsedRow.penalty_label,
    penaltyText: parsedRow.penalty_text,
    effectsEnabled: parseBooleanInteger(parsedRow.effects_enabled),
    maxVisible: parsedRow.max_visible,
    overflowMode: parsedRow.overflow_mode,
    overflowTempo: parsedRow.overflow_tempo,
    numbered: parseBooleanInteger(parsedRow.numbered),
    keyVisible: parseBooleanInteger(parsedRow.key_visible),
    doneOrder: parsedRow.done_order,
    globalTimerMode: parsedRow.global_timer_mode,
    globalTimer,
    placement: challengePlacementSchema.parse({
      x: parsedRow.placement_x,
      y: parsedRow.placement_y,
      scale: parsedRow.placement_scale,
    }),
  });
  return {
    eventSeq: parsedRow.event_seq,
    boardRevision: parsedRow.board_revision,
    settingsRevision: parsedRow.settings_revision,
    ...settings,
  };
};

const parseChallenge = (row: ChallengeRow): Challenge =>
  challengeSchema.parse({
    id: row.id,
    title: row.title,
    kind: row.kind,
    unit: row.unit,
    controlKey: row.control_key,
    targetCount: row.target_count,
    timerTotalMs: row.timer_total_ms,
    sortOrder: row.sort_order,
    step: row.step,
    bestCount: row.best_count,
    hidden: row.hidden === 1,
    currentCount: row.current_count,
    state: row.state,
    timerEndsAt: row.timer_ends_at,
    timerRemainMs: row.timer_remain_ms,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const parseCommand = (row: CommandRow): CommandRecord => {
  const parsed = commandRowSchema.parse(row);
  return {
    commandId: parsed.command_id,
    requestHash: parsed.request_hash,
    createdAt: parsed.created_at,
  };
};

const parseDockToken = (row: DockTokenRow): DockTokenRecord => {
  const parsed = dockTokenRowSchema.parse(row);
  return {
    tokenHash: parsed.token_hash,
    tokenEnvelope: parsed.token_envelope,
    fingerprint: parsed.fingerprint,
    generation: parsed.generation,
    requestId: parsed.request_id,
    creatingSessionHash: parsed.creating_session_hash,
    createdAt: parsed.created_at,
    lastUsedAt: parsed.last_used_at,
  };
};

const parseChallengeSetMetadataRow = (row: ChallengeSetMetadataRow): ChallengeSetSummary => {
  const parsed = challengeSetMetadataRowSchema.parse(row);
  return {
    id: parsed.id,
    type: parsed.type,
    name: parsed.name,
    hasProgress: parsed.has_progress === 1,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
};

const parseChallengeSetLoadRow = (row: ChallengeSetRow): {
  metadata: ChallengeSetMetadataRow;
  payload: string;
} => {
  const parsed = challengeSetRowSchema.parse(row);
  return {
    metadata: {
      id: parsed.id,
      type: parsed.type,
      name: parsed.name,
      normalized_name: parsed.normalized_name,
      has_progress: parsed.has_progress,
      created_at: parsed.created_at,
      updated_at: parsed.updated_at,
    },
    payload: parsed.payload,
  };
};

const sameRuntime = (left: Challenge, right: Challenge): boolean =>
  left.currentCount === right.currentCount &&
  left.bestCount === right.bestCount &&
  left.state === right.state &&
  left.timerEndsAt === right.timerEndsAt &&
  left.timerRemainMs === right.timerRemainMs &&
  left.completedAt === right.completedAt &&
  left.hidden === right.hidden;

const assertChallengeTimerInvariant = (
  challenge: Pick<Challenge, "timerEndsAt" | "timerRemainMs">,
): void => {
  if (challenge.timerEndsAt !== null && challenge.timerRemainMs !== null) {
    throw new ValidationError("Eine Challenge darf nicht gleichzeitig laufen und pausiert sein.");
  }
};

export class SqlStorageChallengeRepository implements ChallengeRepository {
  private readonly sql: SqlStorage;
  private readonly transactionSync: <T>(callback: () => T) => T;
  private readonly tablePrefix: string;
  private readonly onDockTokenDeleted: () => void;
  private metrics: SqlOperationMetrics | null = null;

  public static create(
    options: Omit<SqlStorageChallengeRepositoryOptions, "tablePrefix">,
  ): SqlStorageChallengeRepository {
    return new SqlStorageChallengeRepository({ ...options, tablePrefix: TABLE_PREFIX });
  }

  private constructor(options: SqlStorageChallengeRepositoryOptions) {
    this.sql = options.sql;
    this.transactionSync = options.transactionSync;
    this.tablePrefix = validateTablePrefix(options.tablePrefix);
    this.onDockTokenDeleted = options.onDockTokenDeleted ?? (() => undefined);
  }

  public transaction<T>(callback: (transaction: ChallengeRepositoryTransaction) => T): T {
    return this.transactionSync(() => callback(this.makeTransaction()));
  }

  public readSnapshot(): ChallengeSnapshot {
    return this.readSnapshotInternal();
  }

  public readChallenge(challengeId: string): Challenge | null {
    return this.readChallengeInternal(challengeId);
  }

  public readSet(setId: string): ChallengeSetRecord | null {
    return this.readSetInternal(setId);
  }

  public listSets(): ChallengeSetSummary[] {
    return this.execute<ChallengeSetMetadataRow>(
      // Die Liste braucht nur Metadaten. Das Payload bleibt aus der Abfrage,
      // damit SQLite die Overflow-Seiten des einzelnen Sets nicht laden muss.
      `SELECT id, type, name, normalized_name, has_progress, created_at, updated_at
       FROM ${this.table("sets")} ORDER BY updated_at DESC, id ASC`,
    ).map(parseChallengeSetMetadataRow);
  }

  public saveSet(input: ChallengeSetSaveInput): ChallengeSetRecord {
    return this.transaction((transaction) => {
      const current = transaction.readSnapshot();
      return this.saveSetInTransaction(input, current);
    });
  }

  public deleteSet(setId: string): void {
    this.transaction(() => {
      const existing = this.readSetMetadataInternal(setId);
      if (existing === null) throw new NotFoundError("Set nicht gefunden.");
      if (existing.type === "autosave") {
        throw new ValidationError("Die Autosicherung kann nicht gelöscht werden.");
      }
      this.execute<ChallengeSetRow>(
        `DELETE FROM ${this.table("sets")} WHERE id = ?`,
        setId,
      );
    });
  }

  public saveBoard(input: BoardSaveInput): BoardSaveResult {
    const definitions = input.definitions.map((definition) => {
      try {
        return challengeDefinitionSchema.parse(definition);
      } catch {
        throw new ValidationError("Ungültige Challenge-Definition.");
      }
    });
    if (definitions.length > MAX_CHALLENGES) {
      throw new ValidationError("Es sind höchstens 30 Challenges erlaubt.");
    }

    return this.transaction((transaction) => {
      const current = transaction.readSnapshot();
      if (current.boardRevision !== input.baseBoardRevision) {
        throw new RevisionConflictError(current);
      }
      if (input.setId !== undefined && input.reason !== "set-switch") {
        throw new ValidationError("Ein Set kann nur mit einem Set-Wechsel geladen werden.");
      }
      // Der Payload muss vor dem Autosave gelesen werden: Beim Laden der
      // Autosicherung würde der folgende Upsert sonst genau sein Ziel ersetzen.
      const loadedSet = input.setId === undefined ? null : this.readSetInternal(input.setId);
      if (input.setId !== undefined && loadedSet === null) {
        throw new NotFoundError("Set nicht gefunden.");
      }
      if (input.reason === "set-switch") {
        this.saveAutosaveInTransaction(current, input.now);
      }

      const existingById = new Map(current.challenges.map((challenge) => [challenge.id, challenge]));
      const persistedControlKeys = new Set(current.challenges.map((challenge) => challenge.controlKey));
      const retiredControlKeys = definitions.some((definition) => !("id" in definition))
        ? new Set(
            this.execute<{ control_key: string }>(
              `SELECT control_key FROM ${this.table("retired_keys")}`,
            ).map(({ control_key }) => control_key),
          )
        : new Set<string>();
      const allocatedControlKeys = new Set<string>();
      const seenIds = new Set<string>();
      const seenClientIds = new Set<string>();
      const generatedIds = new Map<string, string>();
      const merged = definitions.map((definition) => {
        if ("id" in definition) {
          if (seenIds.has(definition.id)) throw new ValidationError("Eine Challenge-ID wurde doppelt gesendet.");
          seenIds.add(definition.id);
          const existing = existingById.get(definition.id);
          if (existing === undefined) throw new NotFoundError();
          return {
            definition,
            existing,
            challenge: mergeDefinition(existing, definition, input.now),
          };
        }
        if (seenClientIds.has(definition.clientId)) {
          throw new ValidationError("Eine Client-ID wurde doppelt gesendet.");
        }
        seenClientIds.add(definition.clientId);
        const generatedId = crypto.randomUUID();
        const controlKey = allocateControlKey([
          persistedControlKeys,
          allocatedControlKeys,
          retiredControlKeys,
        ]);
        allocatedControlKeys.add(controlKey);
        generatedIds.set(definition.clientId, generatedId);
        return {
          definition,
          existing: undefined,
          challenge: mergeDefinition(null, definition, input.now, generatedId, controlKey),
        };
      });
      const normalized = normalizeSortOrder(merged.map(({ challenge }) => challenge));
      for (const challenge of normalized) {
        try {
          challengeSchema.parse(challenge);
        } catch {
          throw new ValidationError("Ungültiger Challenge-Stand für den Challenge-Typ.");
        }
      }
      const normalizedById = new Map(normalized.map((challenge) => [challenge.id, challenge]));
      const finalIds = normalized.map(({ id }) => id);
      this.deleteMissingChallenges(finalIds, current.challenges);
      for (const entry of merged) {
        const challenge = normalizedById.get(entry.challenge.id);
        if (challenge === undefined) throw new Error("Challenge-Normalisierung fehlgeschlagen.");
        if (entry.existing === undefined) {
          this.insertChallenge(challenge);
        } else {
          this.updateBoardChallenge(entry.existing, challenge);
        }
      }
      if (loadedSet !== null && loadedSet.summary.hasProgress) {
        this.restoreSetProgress(loadedSet, normalized, input.now);
      }
      this.execute<MetaRow>(
        `UPDATE ${this.table("meta")} SET
           board_revision = board_revision + 1,
           event_seq = event_seq + ?
         WHERE singleton = 1`,
        input.reason === "set-switch" ? 1 : 0,
      );
      const snapshot = this.readSnapshotInternal();
      return {
        snapshot,
        createdIds: Object.fromEntries(generatedIds),
      };
    });
  }

  public saveSettings(input: SettingsSaveInputWithRevision): SettingsSaveResult {
    return this.transaction((transaction) => {
      const current = transaction.readSnapshot();
      if (current.settingsRevision !== input.baseSettingsRevision) {
        throw new RevisionConflictError(current);
      }
      const nextSettings = this.parseSettingsInput(input, current.settings);
      this.execute<MetaRow>(
        `UPDATE ${this.table("meta")} SET
          style_id = ?, theme_mode = ?, surface_opacity = ?, header_style = ?, text_emphasis = ?, font_family = ?, font_scale = ?, header_title = ?, penalty_label = ?, penalty_text = ?,
          effects_enabled = ?, max_visible = ?, overflow_mode = ?, overflow_tempo = ?, numbered = ?, key_visible = ?, done_order = ?,
          global_timer_mode = ?, global_timer_total_ms = ?, global_timer_ends_at = ?, global_timer_paused_remain_ms = ?,
          placement_x = ?, placement_y = ?, placement_scale = ?,
          settings_revision = settings_revision + 1
         WHERE singleton = 1`,
        nextSettings.styleId,
        nextSettings.themeMode,
        nextSettings.surfaceOpacity,
        nextSettings.headerStyle,
        nextSettings.textEmphasis,
        nextSettings.fontFamily,
        nextSettings.fontScale,
        nextSettings.headerTitle,
        nextSettings.penaltyLabel,
        nextSettings.penaltyText,
        nextSettings.effectsEnabled ? 1 : 0,
        nextSettings.maxVisible,
        nextSettings.overflowMode,
        nextSettings.overflowTempo,
        nextSettings.numbered ? 1 : 0,
        nextSettings.keyVisible ? 1 : 0,
        nextSettings.doneOrder,
        nextSettings.globalTimerMode,
        nextSettings.globalTimer?.totalMs ?? null,
        nextSettings.globalTimer?.endsAt ?? null,
        nextSettings.globalTimer?.pausedRemainMs ?? null,
        nextSettings.placement.x,
        nextSettings.placement.y,
        nextSettings.placement.scale,
      );
      return { snapshot: this.readSnapshotInternal() };
    });
  }

  public runCommand<T>(
    command: CommandIdentity,
    execute: (transaction: ChallengeRepositoryTransaction) => CommandMutation<T>,
    replay: (transaction: ChallengeRepositoryTransaction) => T,
  ): CommandResult<T> {
    return this.transaction((transaction) => {
      const previous = this.readCommandInternal(command.commandId);
      if (previous !== null) {
        if (previous.requestHash !== command.requestHash) throw new IdempotencyMismatchError();
        return {
          value: replay(transaction),
          eventSeq: transaction.readSnapshot().eventSeq,
          replayed: true,
        };
      }
      this.insertCommand(command);
      const outcome = execute(transaction);
      const eventSeq = outcome.eventSeq ?? (
        outcome.event === null
          ? transaction.readSnapshot().eventSeq
          : this.bumpEventSeq()
      );
      return { value: outcome.value, eventSeq, replayed: false };
    });
  }

  public pruneCommands(now: DomainNow): void {
    this.transaction((transaction) => {
      transaction.pruneCommands(now);
    });
  }

  public readDockToken(): DockTokenRecord | null {
    return this.readDockTokenInternal();
  }

  public upsertDockToken(token: DockTokenRecord): void {
    this.execute<DockTokenRow>(
      `INSERT INTO ${this.table("dock_tokens")}(
        singleton, token_hash, token_envelope, fingerprint, generation, request_id,
        creating_session_hash, created_at, last_used_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        token_hash = excluded.token_hash,
        token_envelope = excluded.token_envelope,
        fingerprint = excluded.fingerprint,
        generation = excluded.generation,
        request_id = excluded.request_id,
        creating_session_hash = excluded.creating_session_hash,
        created_at = excluded.created_at,
        last_used_at = excluded.last_used_at`,
      token.tokenHash,
      token.tokenEnvelope,
      token.fingerprint,
      token.generation,
      token.requestId,
      token.creatingSessionHash,
      token.createdAt,
      token.lastUsedAt,
    );
  }

  public deleteDockToken(): void {
    this.execute<DockTokenRow>(`DELETE FROM ${this.table("dock_tokens")} WHERE singleton = 1`);
    this.onDockTokenDeleted();
  }

  public measure<T>(operation: () => T): MeasuredSqlOperation<T> {
    if (this.metrics !== null) throw new Error("SQL-Messungen dürfen nicht verschachtelt werden.");
    this.metrics = { rowsRead: 0, rowsWritten: 0 };
    try {
      const result = operation();
      const metrics = this.metrics;
      return {
        result,
        rowsRead: metrics.rowsRead,
        rowsWritten: metrics.rowsWritten,
      };
    } finally {
      this.metrics = null;
    }
  }

  private makeTransaction(): ChallengeRepositoryTransaction {
    return {
      readSnapshot: () => this.readSnapshotInternal(),
      readChallenge: (challengeId) => this.readChallengeInternal(challengeId),
      incrementChallengeCount: (challengeId, delta, maximum, updatedAt, runtime) =>
        this.incrementChallengeCount(challengeId, delta, maximum, updatedAt, runtime),
      updateChallengeRuntime: (challengeId, runtime, updatedAt) =>
        this.updateChallengeRuntime(challengeId, runtime, updatedAt),
      updateGlobalTimer: (globalTimer) => this.updateGlobalTimer(globalTimer),
      pruneCommands: (now) => {
        this.pruneCommandsInternal(now);
      },
      readDockToken: () => this.readDockTokenInternal(),
      upsertDockToken: (token) => {
        this.upsertDockToken(token);
      },
      deleteDockToken: () => {
        this.deleteDockToken();
      },
    };
  }

  private table(name: "meta" | "challenges" | "commands" | "dock_tokens" | "retired_keys" | "sets"): string {
    return `${this.tablePrefix}${name}`;
  }

  private saveSetInTransaction(
    input: ChallengeSetSaveInput,
    current: ChallengeSnapshot,
  ): ChallengeSetRecord {
    const reserved = input.reserved === true;
    const name = reserved ? AUTO_SAVE_SET_NAME : input.name.normalize("NFC").trim();
    if (!reserved && !isChallengeSetName(name)) {
      throw new ValidationError("Set-Name muss normalisiert 1–24 Zeichen lang sein.");
    }
    const requestedId = reserved ? AUTO_SAVE_SET_ID : input.setId;
    const existing = requestedId === undefined ? null : this.readSetMetadataInternal(requestedId);
    if (requestedId !== undefined && existing === null && !reserved) {
      throw new NotFoundError("Set nicht gefunden.");
    }
    if (existing?.type === "autosave" && !reserved) {
      throw new ValidationError("Die Autosicherung kann nicht überschrieben werden.");
    }
    if (!reserved && existing === null) {
      const count = this.execute<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${this.table("sets")} WHERE type = 'user'`,
      )[0]?.count;
      if (count === undefined || count >= MAX_CHALLENGE_SETS) {
        throw new ValidationError("Es sind höchstens 20 eigene Sets erlaubt.");
      }
    }
    if (!reserved) {
      const duplicate = this.execute<{ id: string }>(
        `SELECT id FROM ${this.table("sets")}
         WHERE type = 'user' AND normalized_name = ? AND id <> ?`,
        normalizeChallengeSetName(name),
        requestedId ?? "",
      )[0];
      if (duplicate !== undefined) {
        throw new ValidationError("Ein Set mit diesem Namen gibt es bereits.");
      }
    }

    const setId = requestedId ?? crypto.randomUUID();
    const timestamp = toInstant(input.now);
    const createdAt = existing?.created_at ?? timestamp;
    const includeProgress = reserved || input.includeProgress;
    const payload = encodeChallengeSet(current, {
      name,
      createdAt,
      now: input.now,
      includeProgress,
    });
    const storedPayload = JSON.stringify({
      schemaVersion: payload.schemaVersion,
      challenges: payload.challenges,
    });
    if (existing === null) {
      this.execute<ChallengeSetRow>(
        `INSERT INTO ${this.table("sets")}(
          id, type, name, normalized_name, has_progress, created_at, updated_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        setId,
        reserved ? "autosave" : "user",
        name,
        normalizeChallengeSetName(name),
        includeProgress ? 1 : 0,
        createdAt,
        timestamp,
        storedPayload,
      );
    } else {
      this.execute<ChallengeSetRow>(
        `UPDATE ${this.table("sets")} SET
          type = ?, name = ?, normalized_name = ?, has_progress = ?, updated_at = ?, payload = ?
         WHERE id = ?`,
        reserved ? "autosave" : "user",
        name,
        normalizeChallengeSetName(name),
        includeProgress ? 1 : 0,
        timestamp,
        storedPayload,
        setId,
      );
    }
    const summary = parseChallengeSetMetadataRow({
      id: setId,
      type: reserved ? "autosave" : "user",
      name,
      normalized_name: normalizeChallengeSetName(name),
      has_progress: includeProgress ? 1 : 0,
      created_at: createdAt,
      updated_at: timestamp,
    });
    return { summary, payload };
  }

  private saveAutosaveInTransaction(current: ChallengeSnapshot, now: DomainNow): void {
    this.saveSetInTransaction({
      name: AUTO_SAVE_SET_NAME,
      includeProgress: true,
      reserved: true,
      now,
    }, current);
  }

  private readSetMetadataInternal(setId: string): ChallengeSetMetadataRow | null {
    const row = this.execute<ChallengeSetMetadataRow>(
      `SELECT id, type, name, normalized_name, has_progress, created_at, updated_at
       FROM ${this.table("sets")} WHERE id = ?`,
      setId,
    )[0];
    return row === undefined ? null : challengeSetMetadataRowSchema.parse(row);
  }

  private readSetInternal(setId: string): ChallengeSetRecord | null {
    const row = this.execute<ChallengeSetRow>(
      `SELECT id, type, name, normalized_name, has_progress, created_at, updated_at, payload
       FROM ${this.table("sets")} WHERE id = ?`,
      setId,
    )[0];
    if (row === undefined) return null;
    const parsedRow = parseChallengeSetLoadRow(row);
    let stored: unknown;
    try {
      stored = JSON.parse(parsedRow.payload) as unknown;
    } catch {
      throw new Error("Set-Payload ist kein gültiges JSON.");
    }
    const parsedStored = storedChallengeSetSchema.parse(stored);
    const payload = challengeSetV1Schema.parse({
      schemaVersion: parsedStored.schemaVersion,
      name: parsedRow.metadata.name,
      createdAt: parsedRow.metadata.created_at,
      challenges: parsedStored.challenges,
    });
    const hasProgress = parsedRow.metadata.has_progress === 1;
    if (payload.challenges.some(({ progress }) => (progress !== undefined) !== hasProgress)) {
      throw new Error("Set-Metadaten und Set-Payload haben unterschiedliche Fortschrittsangaben.");
    }
    return {
      summary: parseChallengeSetMetadataRow(parsedRow.metadata),
      payload,
    };
  }

  private restoreSetProgress(
    loadedSet: ChallengeSetRecord,
    challenges: readonly Challenge[],
    now: DomainNow,
  ): void {
    const sortedPayload = [...loadedSet.payload.challenges].sort((left, right) => left.sortOrder - right.sortOrder);
    const sortedChallenges = [...challenges].sort((left, right) => left.sortOrder - right.sortOrder);
    if (sortedPayload.length !== sortedChallenges.length) {
      throw new ValidationError("Der gespeicherte Stand passt nicht zur geladenen Challenge-Anzahl.");
    }
    for (const [index, challenge] of sortedChallenges.entries()) {
      const progress = sortedPayload[index]?.progress;
      if (progress === undefined) throw new ValidationError("Der gespeicherte Challenge-Stand fehlt.");
      const restored = this.updateChallengeRuntime(challenge.id, {
        currentCount: progress.currentCount,
        bestCount: progress.bestCount,
        state: progress.state,
        timerEndsAt: null,
        timerRemainMs: progress.timerRemainMs,
        completedAt: progress.completedAt,
        hidden: challenge.hidden,
      }, toInstant(now));
      if (restored === null) throw new NotFoundError();
    }
  }

  private execute<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    const cursor = this.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    if (this.metrics !== null) {
      this.metrics.rowsRead += cursor.rowsRead;
      this.metrics.rowsWritten += cursor.rowsWritten;
    }
    return rows;
  }

  private readSnapshotInternal(): ChallengeSnapshot {
    const meta = this.execute<MetaRow>(`SELECT * FROM ${this.table("meta")} WHERE singleton = 1`)[0];
    if (meta === undefined) throw new Error("wc_meta ist nicht initialisiert.");
    const parsedMeta = parseMeta(meta);
    const challenges = this.execute<ChallengeRow>(
      `SELECT * FROM ${this.table("challenges")} ORDER BY sort_order ASC`,
    ).map(parseChallenge);
    return {
      eventSeq: parsedMeta.eventSeq,
      boardRevision: parsedMeta.boardRevision,
      settingsRevision: parsedMeta.settingsRevision,
      settings: {
        styleId: parsedMeta.styleId,
        themeMode: parsedMeta.themeMode,
        surfaceOpacity: parsedMeta.surfaceOpacity,
        headerStyle: parsedMeta.headerStyle,
        textEmphasis: parsedMeta.textEmphasis,
        fontFamily: parsedMeta.fontFamily,
        fontScale: parsedMeta.fontScale,
        headerTitle: parsedMeta.headerTitle,
        penaltyLabel: parsedMeta.penaltyLabel,
        penaltyText: parsedMeta.penaltyText,
        effectsEnabled: parsedMeta.effectsEnabled,
        maxVisible: parsedMeta.maxVisible,
        overflowMode: parsedMeta.overflowMode,
        overflowTempo: parsedMeta.overflowTempo,
        numbered: parsedMeta.numbered,
        keyVisible: parsedMeta.keyVisible,
        doneOrder: parsedMeta.doneOrder,
        globalTimerMode: parsedMeta.globalTimerMode,
        globalTimer: parsedMeta.globalTimer,
        placement: parsedMeta.placement,
      },
      challenges,
    };
  }

  private readChallengeInternal(challengeId: string): Challenge | null {
    const row = this.execute<ChallengeRow>(
      `SELECT * FROM ${this.table("challenges")} WHERE id = ?`,
      challengeId,
    )[0];
    return row === undefined ? null : parseChallenge(row);
  }

  private readCommandInternal(commandId: string): CommandRecord | null {
    const row = this.execute<CommandRow>(
      `SELECT command_id, request_hash, created_at FROM ${this.table("commands")} WHERE command_id = ?`,
      commandId,
    )[0];
    return row === undefined ? null : parseCommand(row);
  }

  private insertCommand(command: CommandIdentity): void {
    this.execute<CommandRow>(
      `INSERT INTO ${this.table("commands")}(command_id, request_hash, created_at) VALUES (?, ?, ?)`,
      command.commandId,
      command.requestHash,
      command.createdAt,
    );
  }

  private incrementChallengeCount(
    challengeId: string,
    delta: number,
    maximum: number,
    updatedAt: string,
    runtime?: Pick<ChallengeRuntime, "currentCount" | "bestCount" | "state" | "timerEndsAt" | "timerRemainMs" | "completedAt" | "hidden">,
  ): Challenge | null {
    if (runtime !== undefined) assertChallengeTimerInvariant(runtime);
    const current = this.readChallengeInternal(challengeId);
    if (current === null) return null;
    if (
      !Number.isSafeInteger(delta) ||
      !isDeltaForKind(delta, current.kind) ||
      !Number.isSafeInteger(maximum) ||
      maximum < 0 ||
      maximum > maxCountForKind(current.kind)
    ) {
      throw new ValidationError("Ungültige Zählergrenze.");
    }
    if (runtime !== undefined && (
      !isCurrentCountForKind(runtime.currentCount, current.kind) ||
      !isCurrentCountForKind(runtime.bestCount, current.kind)
    )) {
      throw new ValidationError("Ungültiger Zählerstand für den Challenge-Typ.");
    }
    if (runtime === undefined) {
      this.execute<ChallengeRow>(
        `UPDATE ${this.table("challenges")}
         SET current_count = MIN(MAX(current_count + ?, 0), ?),
             best_count = MAX(best_count, MIN(MAX(current_count + ?, 0), ?)),
             updated_at = ?
         WHERE id = ? AND state <> 'done'`,
        delta,
        maximum,
        delta,
        maximum,
        updatedAt,
        challengeId,
      );
    } else {
      this.execute<ChallengeRow>(
        `UPDATE ${this.table("challenges")} SET
          current_count = MIN(MAX(current_count + ?, 0), ?), best_count = MAX(best_count, ?), state = ?,
          timer_ends_at = ?, timer_remain_ms = ?, completed_at = ?, hidden = ?, updated_at = ?
        WHERE id = ? AND state <> 'done'`,
        delta,
        maximum,
        runtime.bestCount,
        runtime.state,
        runtime.timerEndsAt,
        runtime.timerRemainMs,
        runtime.completedAt,
        runtime.hidden ? 1 : 0,
        updatedAt,
        challengeId,
      );
    }
    return this.readChallengeInternal(challengeId);
  }

  private updateChallengeRuntime(
    challengeId: string,
    runtime: ChallengeRuntime,
    updatedAt: string,
  ): Challenge | null {
    assertChallengeTimerInvariant(runtime);
    const current = this.readChallengeInternal(challengeId);
    if (current === null) return null;
    if (
      !isCurrentCountForKind(runtime.currentCount, current.kind) ||
      !isCurrentCountForKind(runtime.bestCount, current.kind)
    ) {
      throw new ValidationError("Ungültiger Zählerstand für den Challenge-Typ.");
    }
    this.execute<ChallengeRow>(
      `UPDATE ${this.table("challenges")} SET
        current_count = ?, best_count = MAX(best_count, ?), state = ?, timer_ends_at = ?, timer_remain_ms = ?, completed_at = ?, hidden = ?, updated_at = ?
       WHERE id = ?`,
      runtime.currentCount,
      runtime.bestCount,
      runtime.state,
      runtime.timerEndsAt,
      runtime.timerRemainMs,
      runtime.completedAt,
      runtime.hidden ? 1 : 0,
      updatedAt,
      challengeId,
    );
    return this.readChallengeInternal(challengeId);
  }

  private updateGlobalTimer(globalTimer: GlobalTimer | null): number {
    this.execute<MetaRow>(
      `UPDATE ${this.table("meta")} SET
        global_timer_total_ms = ?, global_timer_ends_at = ?, global_timer_paused_remain_ms = ?,
        event_seq = event_seq + 1
       WHERE singleton = 1`,
      globalTimer?.totalMs ?? null,
      globalTimer?.endsAt ?? null,
      globalTimer?.pausedRemainMs ?? null,
    );
    return this.readEventSeq();
  }

  private bumpEventSeq(): number {
    this.execute<MetaRow>(
      `UPDATE ${this.table("meta")} SET event_seq = event_seq + 1 WHERE singleton = 1`,
    );
    return this.readEventSeq();
  }

  private readEventSeq(): number {
    const row = this.execute<{ event_seq: number }>(
      `SELECT event_seq FROM ${this.table("meta")} WHERE singleton = 1`,
    )[0];
    if (row === undefined || !isEventSeq(row.event_seq)) throw new Error("event_seq konnte nicht gelesen werden.");
    return row.event_seq;
  }

  private pruneCommandsInternal(now: DomainNow): void {
    const cutoff = new Date(toMilliseconds(now) - DAY_MS).toISOString();
    this.execute<CommandRow>(
      `DELETE FROM ${this.table("commands")} WHERE created_at < ?`,
      cutoff,
    );
  }

  private readDockTokenInternal(): DockTokenRecord | null {
    const row = this.execute<DockTokenRow>(
      `SELECT * FROM ${this.table("dock_tokens")} WHERE singleton = 1`,
    )[0];
    return row === undefined ? null : parseDockToken(row);
  }

  private parseSettingsInput(
    input: SettingsSaveInputWithRevision,
    current: ChallengeRepositorySettings,
  ): ChallengeRepositorySettings {
    if (!isGlobalTimerMode(input.globalTimerMode)) {
      throw new ValidationError("Ungültiger globaler Timer-Modus.");
    }
    if (!isGlobalTimerTotalMs(input.globalTimerTotalMs)) {
      throw new ValidationError("Ungültige globale Timerdauer.");
    }
    let globalTimer: ChallengeRepositorySettings["globalTimer"];
    if (input.globalTimerTotalMs === null) {
      globalTimer = null;
    } else if (current.globalTimer === null) {
      globalTimer = { totalMs: input.globalTimerTotalMs, endsAt: null, pausedRemainMs: null };
    } else if (current.globalTimer.totalMs !== input.globalTimerTotalMs) {
      // Eine geänderte Dauer darf keinen alten Lauf mit einer neuen Gesamtdauer
      // weiterführen. Wie resetGlobalTimer setzt der neue Timer deshalb auf idle;
      // die neue Dauer gilt beim nächsten Start.
      globalTimer = { totalMs: input.globalTimerTotalMs, endsAt: null, pausedRemainMs: null };
    } else {
      globalTimer = globalTimerSchema.parse({
        ...current.globalTimer,
        totalMs: input.globalTimerTotalMs,
      });
    }
    return persistedSettingsSchema.parse({
      styleId: input.styleId,
      themeMode: input.themeMode,
      surfaceOpacity: input.surfaceOpacity,
      headerStyle: input.headerStyle,
      textEmphasis: input.textEmphasis,
      fontFamily: input.fontFamily,
      fontScale: input.fontScale,
      headerTitle: input.headerTitle,
      penaltyLabel: input.penaltyLabel,
      penaltyText: input.penaltyText,
      effectsEnabled: input.effectsEnabled,
      maxVisible: input.maxVisible,
      overflowMode: input.overflowMode,
      overflowTempo: input.overflowTempo,
      numbered: input.numbered,
      keyVisible: input.keyVisible,
      doneOrder: input.doneOrder,
      globalTimerMode: input.globalTimerMode,
      globalTimer,
      placement: input.placement,
    });
  }

  private deleteMissingChallenges(
    ids: readonly string[],
    currentChallenges: readonly Pick<Challenge, "id" | "controlKey">[],
  ): void {
    const finalIds = new Set(ids);
    const missingControlKeys = currentChallenges
      .filter(({ id }) => !finalIds.has(id))
      .map(({ controlKey }) => controlKey);
    if (missingControlKeys.length > 0) {
      this.execute<Pick<ChallengeRow, "control_key">>(
        `INSERT OR IGNORE INTO ${this.table("retired_keys")}(control_key) VALUES ${missingControlKeys.map(() => "(?)").join(", ")}`,
        ...missingControlKeys,
      );
    } else {
      return;
    }
    if (ids.length === 0) {
      this.execute<ChallengeRow>(`DELETE FROM ${this.table("challenges")}`);
      return;
    }
    this.execute<ChallengeRow>(
      `DELETE FROM ${this.table("challenges")} WHERE id NOT IN (${ids.map(() => "?").join(", ")})`,
      ...ids,
    );
  }

  private insertChallenge(challenge: Challenge): void {
    assertChallengeTimerInvariant(challenge);
    this.execute<ChallengeRow>(
      `INSERT INTO ${this.table("challenges")}(
        id, title, kind, unit, control_key, target_count, timer_total_ms, sort_order,
        step, best_count, hidden, current_count, state, timer_ends_at, timer_remain_ms, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      challenge.id,
      challenge.title,
      challenge.kind,
      challenge.unit,
      challenge.controlKey,
      challenge.targetCount,
      challenge.timerTotalMs,
      challenge.sortOrder,
      challenge.step,
      challenge.bestCount,
      challenge.hidden ? 1 : 0,
      challenge.currentCount,
      challenge.state,
      challenge.timerEndsAt,
      challenge.timerRemainMs,
      challenge.completedAt,
      challenge.createdAt,
      challenge.updatedAt,
    );
  }

  private updateBoardChallenge(existing: Challenge, challenge: Challenge): void {
    assertChallengeTimerInvariant(challenge);
    if (sameRuntime(existing, challenge)) {
      this.execute<ChallengeRow>(
        `UPDATE ${this.table("challenges")} SET
          title = ?, kind = ?, unit = ?, target_count = ?, timer_total_ms = ?,
          sort_order = ?, step = ?, best_count = ?, hidden = ?, updated_at = ?
         WHERE id = ?`,
        challenge.title,
        challenge.kind,
        challenge.unit,
        challenge.targetCount,
        challenge.timerTotalMs,
        challenge.sortOrder,
        challenge.step,
        challenge.bestCount,
        challenge.hidden ? 1 : 0,
        challenge.updatedAt,
        challenge.id,
      );
      return;
    }
    this.execute<ChallengeRow>(
      `UPDATE ${this.table("challenges")} SET
        title = ?, kind = ?, unit = ?, target_count = ?, timer_total_ms = ?, sort_order = ?, step = ?,
        best_count = ?, hidden = ?, current_count = ?, state = ?, timer_ends_at = ?, timer_remain_ms = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
      challenge.title,
      challenge.kind,
      challenge.unit,
      challenge.targetCount,
      challenge.timerTotalMs,
      challenge.sortOrder,
      challenge.step,
      challenge.bestCount,
      challenge.hidden ? 1 : 0,
      challenge.currentCount,
      challenge.state,
      challenge.timerEndsAt,
      challenge.timerRemainMs,
      challenge.completedAt,
      challenge.updatedAt,
      challenge.id,
    );
  }
}

export const createSqlStorageChallengeRepository = (
  options: Omit<SqlStorageChallengeRepositoryOptions, "tablePrefix">,
): SqlStorageChallengeRepository =>
  SqlStorageChallengeRepository.create(options);
