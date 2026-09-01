import type { Challenge, ChallengeDefinition } from "../contracts/schemas";
import type { DomainNow } from "./timers";

const toInstant = (now: DomainNow): string => {
  const milliseconds = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError("now muss ein gültiger Zeitpunkt sein.");
  }
  return new Date(milliseconds).toISOString();
};

const getDefinitionId = (
  definition: ChallengeDefinition,
  generatedId?: string,
): string => {
  if ("id" in definition) return definition.id;
  if (generatedId !== undefined && generatedId.length > 0) return generatedId;
  throw new Error("Für eine neue Challenge wird eine serverseitige ID benötigt.");
};

export const mergeDefinition = (
  existing: Challenge | null | undefined,
  definition: ChallengeDefinition,
  now: DomainNow,
  generatedId?: string,
): Challenge => {
  if (existing === null || existing === undefined) {
    const timestamp = toInstant(now);
    return {
      id: getDefinitionId(definition, generatedId),
      title: definition.title,
      targetCount: definition.targetCount,
      timerTotalMs: definition.timerTotalMs,
      sortOrder: definition.sortOrder,
      hidden: definition.hidden,
      currentCount: 0,
      state: "pending",
      timerEndsAt: null,
      timerRemainMs: null,
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  const timestamp = toInstant(now);
  const timerRemoved = definition.timerTotalMs === null;
  const timerChanged = definition.timerTotalMs !== existing.timerTotalMs;
  const currentCount =
    definition.targetCount === null
      ? existing.currentCount
      : Math.min(existing.currentCount, definition.targetCount);

  return {
    ...existing,
    title: definition.title,
    targetCount: definition.targetCount,
    timerTotalMs: definition.timerTotalMs,
    sortOrder: definition.sortOrder,
    hidden: existing.state === "done" ? false : definition.hidden,
    currentCount,
    state: timerRemoved && existing.state === "active" ? "pending" : existing.state,
    timerEndsAt: timerRemoved ? null : existing.timerEndsAt,
    timerRemainMs: timerChanged ? null : existing.timerRemainMs,
    updatedAt: timestamp,
  };
};

export const normalizeSortOrder = (
  challenges: readonly Challenge[],
): Challenge[] =>
  challenges
    .map((challenge, index) => ({ challenge, index }))
    .sort((left, right) =>
      left.challenge.sortOrder - right.challenge.sortOrder || left.index - right.index,
    )
    .map(({ challenge }, sortOrder) => ({ ...challenge, sortOrder }));
