import type {
  Challenge,
  ChallengeBoardSnapshot,
  ChallengeDefinition,
  ChallengeSetV1,
  ChallengeSetV1Challenge,
} from "../contracts/schemas";
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
