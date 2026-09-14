import type { Challenge, ChallengeDefinition } from "../contracts/schemas";
import { MAX_COUNT } from "../contracts/predicates";
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
  controlKey?: string,
): Challenge => {
  if (existing === null || existing === undefined) {
    const timestamp = toInstant(now);
    if (controlKey === undefined) {
      throw new Error("Für eine neue Challenge wird ein serverseitiger Steuer-Key benötigt.");
    }
    return {
      id: getDefinitionId(definition, generatedId),
      title: definition.title,
      kind: definition.kind,
      unit: definition.unit,
      controlKey,
      targetCount: definition.targetCount,
      timerTotalMs: definition.timerTotalMs,
      sortOrder: definition.sortOrder,
      step: definition.step,
      bestCount: 0,
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
  const kindChanged = definition.kind !== existing.kind;
  const timerRemoved = definition.timerTotalMs === null;
  const timerChanged = definition.timerTotalMs !== existing.timerTotalMs;
  const currentCount = kindChanged
    ? 0
    : definition.kind === "measure"
      ? existing.currentCount
      : definition.targetCount === null
        ? Math.min(existing.currentCount, MAX_COUNT)
        : Math.min(existing.currentCount, definition.targetCount);

  return {
    ...existing,
    title: definition.title,
    kind: definition.kind,
    unit: definition.unit,
    targetCount: definition.targetCount,
    timerTotalMs: definition.timerTotalMs,
    sortOrder: definition.sortOrder,
    step: definition.step,
    hidden: existing.state === "done" ? false : definition.hidden,
    currentCount,
    bestCount: kindChanged ? 0 : existing.bestCount,
    state: kindChanged
      ? "pending"
      : timerRemoved && existing.state === "active"
        ? "pending"
        : existing.state,
    timerEndsAt: kindChanged ? null : timerRemoved ? null : existing.timerEndsAt,
    timerRemainMs: kindChanged ? null : timerChanged ? null : existing.timerRemainMs,
    completedAt: kindChanged ? null : existing.completedAt,
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
