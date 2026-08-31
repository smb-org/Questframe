import { z } from "zod";

import {
  challengeDefinitionSchema,
  challengeSchema,
  globalTimerSchema,
  settingsSchema,
  type Challenge,
  type GlobalTimer,
} from "../contracts/schemas";
import { MAX_CHALLENGES, MAX_COUNT, isEventSeq, isRevision, isTimerTotalMs } from "../contracts/predicates";
import { mergeDefinition, normalizeSortOrder } from "../domain/definitions";
import type { DomainNow } from "../domain/timers";
import {
  IdempotencyMismatchError,
  NotFoundError,
  RevisionConflictError,
  ValidationError,
  type BoardSaveInput,
  type BoardSaveResult,
  type ChallengeRepository,
  type ChallengeRepositorySettings,
  type ChallengeRepositoryTransaction,
  type ChallengeRuntime,
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
  surface_mode: string;
  header_title: string;
  effects_enabled: number;
  max_visible: number;
  global_timer_total_ms: number | null;
  global_timer_ends_at: string | null;
  global_timer_paused_remain_ms: number | null;
};

type ChallengeRow = {
  id: string;
  title: string;
  description: string | null;
  target_count: number | null;
  timer_total_ms: number | null;
  sort_order: number;
  current_count: number;
  state: string;
  timer_ends_at: string | null;
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

const persistedSettingsSchema = settingsSchema.omit({ themeId: true });
const metaRowSchema = z.strictObject({
  singleton: z.literal(1),
  event_seq: z.number().int().nonnegative(),
  board_revision: z.number().int().positive(),
  settings_revision: z.number().int().positive(),
  style_id: z.string(),
  theme_mode: z.string(),
  surface_mode: z.string(),
  header_title: z.string(),
  effects_enabled: z.number().int(),
  max_visible: z.number().int(),
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
    surfaceMode: parsedRow.surface_mode,
    headerTitle: parsedRow.header_title,
    effectsEnabled: parseBooleanInteger(parsedRow.effects_enabled),
    maxVisible: parsedRow.max_visible,
    globalTimer,
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
    description: row.description,
    targetCount: row.target_count,
    timerTotalMs: row.timer_total_ms,
    sortOrder: row.sort_order,
    currentCount: row.current_count,
    state: row.state,
    timerEndsAt: row.timer_ends_at,
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

const sameRuntime = (left: Challenge, right: Challenge): boolean =>
  left.currentCount === right.currentCount &&
  left.state === right.state &&
  left.timerEndsAt === right.timerEndsAt &&
  left.completedAt === right.completedAt;

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

      const existingById = new Map(current.challenges.map((challenge) => [challenge.id, challenge]));
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
        generatedIds.set(definition.clientId, generatedId);
        return {
          definition,
          existing: undefined,
          challenge: mergeDefinition(null, definition, input.now, generatedId),
        };
      });
      const normalized = normalizeSortOrder(merged.map(({ challenge }) => challenge));
      const normalizedById = new Map(normalized.map((challenge) => [challenge.id, challenge]));
      const finalIds = normalized.map(({ id }) => id);
      this.deleteMissingChallenges(finalIds);
      for (const entry of merged) {
        const challenge = normalizedById.get(entry.challenge.id);
        if (challenge === undefined) throw new Error("Challenge-Normalisierung fehlgeschlagen.");
        if (entry.existing === undefined) {
          this.insertChallenge(challenge);
        } else {
          this.updateBoardChallenge(entry.existing, challenge);
        }
      }
      this.execute<MetaRow>(
        `UPDATE ${this.table("meta")} SET board_revision = board_revision + 1 WHERE singleton = 1`,
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
          style_id = ?, theme_mode = ?, surface_mode = ?, header_title = ?,
          effects_enabled = ?, max_visible = ?, global_timer_total_ms = ?,
          global_timer_ends_at = CASE WHEN ? IS NULL THEN NULL ELSE global_timer_ends_at END,
          global_timer_paused_remain_ms = CASE WHEN ? IS NULL THEN NULL ELSE global_timer_paused_remain_ms END,
          settings_revision = settings_revision + 1
         WHERE singleton = 1`,
        nextSettings.styleId,
        nextSettings.themeMode,
        nextSettings.surfaceMode,
        nextSettings.headerTitle,
        nextSettings.effectsEnabled ? 1 : 0,
        nextSettings.maxVisible,
        input.globalTimerTotalMs,
        input.globalTimerTotalMs,
        input.globalTimerTotalMs,
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

  private table(name: "meta" | "challenges" | "commands" | "dock_tokens"): string {
    return `${this.tablePrefix}${name}`;
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
        surfaceMode: parsedMeta.surfaceMode,
        headerTitle: parsedMeta.headerTitle,
        effectsEnabled: parsedMeta.effectsEnabled,
        maxVisible: parsedMeta.maxVisible,
        globalTimer: parsedMeta.globalTimer,
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
    runtime?: Pick<ChallengeRuntime, "state" | "timerEndsAt" | "completedAt">,
  ): Challenge | null {
    if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_COUNT) {
      throw new ValidationError("Ungültige Zählergrenze.");
    }
    if (runtime === undefined) {
      this.execute<ChallengeRow>(
        `UPDATE ${this.table("challenges")}
         SET current_count = MIN(MAX(current_count + ?, 0), ?), updated_at = ?
         WHERE id = ? AND state <> 'done'`,
        delta,
        maximum,
        updatedAt,
        challengeId,
      );
    } else {
      this.execute<ChallengeRow>(
        `UPDATE ${this.table("challenges")} SET
          current_count = MIN(MAX(current_count + ?, 0), ?), state = ?,
          timer_ends_at = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND state <> 'done'`,
        delta,
        maximum,
        runtime.state,
        runtime.timerEndsAt,
        runtime.completedAt,
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
    this.execute<ChallengeRow>(
      `UPDATE ${this.table("challenges")} SET
        current_count = ?, state = ?, timer_ends_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
      runtime.currentCount,
      runtime.state,
      runtime.timerEndsAt,
      runtime.completedAt,
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
    if (!isTimerTotalMs(input.globalTimerTotalMs)) {
      throw new ValidationError("Ungültige globale Timerdauer.");
    }
    let globalTimer: ChallengeRepositorySettings["globalTimer"];
    if (input.globalTimerTotalMs === null) {
      globalTimer = null;
    } else if (current.globalTimer === null) {
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
      surfaceMode: input.surfaceMode,
      headerTitle: input.headerTitle,
      effectsEnabled: input.effectsEnabled,
      maxVisible: input.maxVisible,
      globalTimer,
    });
  }

  private deleteMissingChallenges(ids: readonly string[]): void {
    if (ids.length === 0) {
      this.execute<ChallengeRow>(`DELETE FROM ${this.table("challenges")}`);
      return;
    }
    const placeholders = ids.map(() => "?").join(", ");
    this.execute<ChallengeRow>(
      `DELETE FROM ${this.table("challenges")} WHERE id NOT IN (${placeholders})`,
      ...ids,
    );
  }

  private insertChallenge(challenge: Challenge): void {
    this.execute<ChallengeRow>(
      `INSERT INTO ${this.table("challenges")}(
        id, title, description, target_count, timer_total_ms, sort_order,
        current_count, state, timer_ends_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      challenge.id,
      challenge.title,
      challenge.description,
      challenge.targetCount,
      challenge.timerTotalMs,
      challenge.sortOrder,
      challenge.currentCount,
      challenge.state,
      challenge.timerEndsAt,
      challenge.completedAt,
      challenge.createdAt,
      challenge.updatedAt,
    );
  }

  private updateBoardChallenge(existing: Challenge, challenge: Challenge): void {
    if (sameRuntime(existing, challenge)) {
      this.execute<ChallengeRow>(
        `UPDATE ${this.table("challenges")} SET
          title = ?, description = ?, target_count = ?, timer_total_ms = ?,
          sort_order = ?, updated_at = ?
         WHERE id = ?`,
        challenge.title,
        challenge.description,
        challenge.targetCount,
        challenge.timerTotalMs,
        challenge.sortOrder,
        challenge.updatedAt,
        challenge.id,
      );
      return;
    }
    this.execute<ChallengeRow>(
      `UPDATE ${this.table("challenges")} SET
        title = ?, description = ?, target_count = ?, timer_total_ms = ?, sort_order = ?,
        current_count = ?, state = ?, timer_ends_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
      challenge.title,
      challenge.description,
      challenge.targetCount,
      challenge.timerTotalMs,
      challenge.sortOrder,
      challenge.currentCount,
      challenge.state,
      challenge.timerEndsAt,
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
