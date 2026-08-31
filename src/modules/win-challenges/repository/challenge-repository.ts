import type { ChallengeEvent, GlobalTimerEvent } from "../contracts/events";
import type { Challenge, ChallengeDefinition, GlobalTimer, Settings } from "../contracts/schemas";
import type { DomainError, DomainNow } from "../domain/timers";

export type ChallengeRepositorySettings = Omit<Settings, "themeId">;

export type ChallengeSnapshot = {
  eventSeq: number;
  boardRevision: number;
  settingsRevision: number;
  settings: ChallengeRepositorySettings;
  challenges: Challenge[];
};

export type SettingsSaveInput = Omit<ChallengeRepositorySettings, "globalTimer"> & {
  globalTimerTotalMs: number | null;
};

export type BoardSaveInput = {
  baseBoardRevision: number;
  definitions: readonly ChallengeDefinition[];
  now: DomainNow;
};

export type BoardSaveResult = {
  snapshot: ChallengeSnapshot;
  createdIds: Record<string, string>;
};

export type SettingsSaveInputWithRevision = SettingsSaveInput & {
  baseSettingsRevision: number;
  now: DomainNow;
};

export type SettingsSaveResult = {
  snapshot: ChallengeSnapshot;
};

export type CommandIdentity = {
  commandId: string;
  requestHash: string;
  createdAt: string;
};

export type CommandRecord = CommandIdentity;

export type ChallengeRuntime = Pick<
  Challenge,
  "currentCount" | "state" | "timerEndsAt" | "completedAt" | "hidden"
>;

export type CommandMutation<T> = {
  value: T;
  event: ChallengeEvent | GlobalTimerEvent | null;
  // Globale Timer-Updates erhöhen event_seq atomar mit dem Meta-Update.
  eventSeq?: number;
};

export type CommandResult<T> = {
  value: T;
  eventSeq: number;
  replayed: boolean;
};

export type DockTokenRecord = {
  tokenHash: string;
  tokenEnvelope: string | null;
  fingerprint: string;
  generation: number;
  requestId: string;
  creatingSessionHash: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type ChallengeRepositoryErrorCode =
  | "idempotency_mismatch"
  | "not_found"
  | "revision_conflict"
  | "validation_failed"
  | DomainError;

export class ChallengeRepositoryError extends Error {
  public readonly code: ChallengeRepositoryErrorCode;

  public constructor(code: ChallengeRepositoryErrorCode, message: string) {
    super(message);
    this.name = "ChallengeRepositoryError";
    this.code = code;
  }
}

export class IdempotencyMismatchError extends ChallengeRepositoryError {
  public constructor() {
    super("idempotency_mismatch", "Die Command-ID wurde mit einem anderen Request wiederholt.");
    this.name = "IdempotencyMismatchError";
  }
}

export class NotFoundError extends ChallengeRepositoryError {
  public constructor(message = "Challenge nicht gefunden.") {
    super("not_found", message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends ChallengeRepositoryError {
  public constructor(message: string, code: "validation_failed" | DomainError = "validation_failed") {
    super(code, message);
    this.name = "ValidationError";
  }
}

export class RevisionConflictError extends ChallengeRepositoryError {
  public readonly snapshot: ChallengeSnapshot;

  public constructor(snapshot: ChallengeSnapshot) {
    super("revision_conflict", "Die Challenge-Konfiguration wurde inzwischen geändert.");
    this.name = "RevisionConflictError";
    this.snapshot = snapshot;
  }
}

export interface ChallengeRepositoryTransaction {
  readSnapshot(): ChallengeSnapshot;
  readChallenge(challengeId: string): Challenge | null;
  incrementChallengeCount(
    challengeId: string,
    delta: number,
    maximum: number,
    updatedAt: string,
    runtime?: Pick<ChallengeRuntime, "state" | "timerEndsAt" | "completedAt" | "hidden">,
  ): Challenge | null;
  updateChallengeRuntime(
    challengeId: string,
    runtime: ChallengeRuntime,
    updatedAt: string,
  ): Challenge | null;
  updateGlobalTimer(globalTimer: GlobalTimer | null): number;
  pruneCommands(now: DomainNow): void;
  readDockToken(): DockTokenRecord | null;
  upsertDockToken(token: DockTokenRecord): void;
  deleteDockToken(): void;
}

export interface ChallengeRepository {
  transaction<T>(callback: (transaction: ChallengeRepositoryTransaction) => T): T;
  readSnapshot(): ChallengeSnapshot;
  readChallenge(challengeId: string): Challenge | null;
  saveBoard(input: BoardSaveInput): BoardSaveResult;
  saveSettings(input: SettingsSaveInputWithRevision): SettingsSaveResult;
  runCommand<T>(
    command: CommandIdentity,
    execute: (transaction: ChallengeRepositoryTransaction) => CommandMutation<T>,
    replay: (transaction: ChallengeRepositoryTransaction) => T,
  ): CommandResult<T>;
  pruneCommands(now: DomainNow): void;
  readDockToken(): DockTokenRecord | null;
  upsertDockToken(token: DockTokenRecord): void;
  deleteDockToken(): void;
}
