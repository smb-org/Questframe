import type {
  Challenge,
  ChallengeBoardSnapshot,
  ChallengeDefinition,
  ChallengeSetV1,
  ChallengeSetV1Challenge,
} from "../contracts/schemas";
import { challengeSetV1Schema } from "../contracts/schemas";
import { MAX_TIMER_REMAIN_MS } from "../contracts/predicates";
import type { DomainNow } from "./timers";
import { clampTimerRemainMs } from "./timers";

export type ChallengeSetExportOptions = {
  name: string;
  createdAt: DomainNow;
  now: DomainNow;
  includeProgress?: boolean;
};

export type ChallengeSetProgress = NonNullable<ChallengeSetV1Challenge["progress"]>;

export type ChallengeSetImportResult = {
  definitions: ChallengeDefinition[];
  progress: (ChallengeSetProgress | null)[] | null;
};

const clampLegacyTimerRemainMs = (value: unknown): unknown => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return value;
  return value < -MAX_TIMER_REMAIN_MS || value > MAX_TIMER_REMAIN_MS
    ? clampTimerRemainMs(value)
    : value;
};

/**
 * Bewusste Asymmetrie: Schreiben bleibt streng; beim Lesen klemmen wir nur alte numerische Restzeiten,
 * damit vor dem Fix gespeicherte Sets wieder geladen und gelöscht werden können.
 * Fehlende Felder, falsche Typen, unbekannte Schlüssel und alle anderen Schemafehler
 * bleiben durch das unveränderte V1-Schema abgelehnt.
 */
export const normalizeChallengeSetForRead = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.challenges)) return value;

  const originalChallenges = record.challenges as unknown[];
  const challenges = originalChallenges.map((challenge: unknown): unknown => {
    if (typeof challenge !== "object" || challenge === null || Array.isArray(challenge)) return challenge;
    const challengeRecord = challenge as Record<string, unknown>;
    const progress = challengeRecord.progress;
    if (typeof progress !== "object" || progress === null || Array.isArray(progress)) return challenge;
    const progressRecord = progress as Record<string, unknown>;
    const timerRemainMs = progressRecord.timerRemainMs;
    const clamped = clampLegacyTimerRemainMs(timerRemainMs);
    if (clamped === timerRemainMs) return challenge;
    return {
      ...challengeRecord,
      progress: { ...progressRecord, timerRemainMs: clamped },
    };
  });

  return challenges.some((challenge, index) => challenge !== originalChallenges[index])
    ? { ...record, challenges }
    : value;
};

export const parseChallengeSetForRead = (value: unknown): ChallengeSetV1 =>
  challengeSetV1Schema.parse(normalizeChallengeSetForRead(value));

const toMilliseconds = (now: DomainNow): number => {
  const milliseconds = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError("now muss ein gültiger Zeitpunkt sein.");
  }
  return milliseconds;
};

const toInstant = (now: DomainNow): string => new Date(toMilliseconds(now)).toISOString();

const pausedRemainFor = (challenge: Challenge, now: DomainNow): number | null => {
  if (challenge.timerEndsAt === null) return challenge.timerRemainMs;
  const endsAt = Date.parse(challenge.timerEndsAt);
  if (!Number.isFinite(endsAt)) {
    throw new RangeError("timerEndsAt muss ein gültiger Zeitpunkt sein.");
  }
  return clampTimerRemainMs(endsAt - toMilliseconds(now));
};

const definitionFieldsOf = (challenge: Challenge): Omit<ChallengeSetV1Challenge, "progress"> => ({
  title: challenge.title,
  kind: challenge.kind,
  unit: challenge.unit,
  targetCount: challenge.targetCount,
  timerTotalMs: challenge.timerTotalMs,
  sortOrder: challenge.sortOrder,
  step: challenge.step,
  hidden: challenge.hidden,
});

const challengeToSetEntry = (
  challenge: Challenge,
  options: ChallengeSetExportOptions,
): ChallengeSetV1Challenge => {
  const fields = definitionFieldsOf(challenge);
  if (options.includeProgress !== true) return fields;
  return {
    ...fields,
    progress: {
      currentCount: challenge.currentCount,
      bestCount: challenge.bestCount,
      state: challenge.timerEndsAt === null ? challenge.state : "pending",
      timerRemainMs: pausedRemainFor(challenge, options.now),
      completedAt: challenge.completedAt,
    },
  };
};

export const encodeChallengeSet = (
  snapshot: Pick<ChallengeBoardSnapshot, "challenges">,
  options: ChallengeSetExportOptions,
): ChallengeSetV1 => ({
  schemaVersion: 1,
  name: options.name,
  createdAt: toInstant(options.createdAt),
  challenges: snapshot.challenges.map((challenge) => challengeToSetEntry(challenge, options)),
});

const clientIdForImportedChallenge = (): string => `client-${crypto.randomUUID()}`;

const definitionFieldsFromSetEntry = (challenge: ChallengeSetV1Challenge): Omit<ChallengeSetV1Challenge, "progress"> => ({
  title: challenge.title,
  kind: challenge.kind,
  unit: challenge.unit,
  targetCount: challenge.targetCount,
  timerTotalMs: challenge.timerTotalMs,
  sortOrder: challenge.sortOrder,
  step: challenge.step,
  hidden: challenge.hidden,
});

export const decodeChallengeSet = (
  payload: ChallengeSetV1,
  options: { preserveProgress?: boolean } = {},
): ChallengeSetImportResult => ({
  definitions: payload.challenges.map((challenge) => ({
    clientId: clientIdForImportedChallenge(),
    ...definitionFieldsFromSetEntry(challenge),
  })),
  progress: options.preserveProgress === true
    ? payload.challenges.map((challenge) => challenge.progress ?? null)
    : null,
});
