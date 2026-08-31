import type {
  Challenge,
  ChallengeEvent,
  ChallengeSettings,
  ChallengeUpdate,
  GlobalTimer,
  GlobalTimerEvent,
} from "../shared/contracts/win-challenges";
import {
  isChallengeDescription,
  isChallengeId,
  isChallengeState,
  isChallengeStyleId,
  isChallengeTitle,
  isCurrentCount,
  isDelta,
  isEventSeq,
  isHeaderTitle,
  isInstant,
  isMaxVisible,
  isPausedRemainMs,
  isRevision,
  isSortOrder,
  isTargetCount,
  isThemeId,
  isThemeMode,
  isSurfaceMode,
  isTimerTotalMs,
  MAX_CHALLENGES,
} from "../modules/win-challenges/contracts/predicates";

export type ChallengeMessage = ChallengeUpdate | { type: "token_revoked" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const present = Object.keys(value).sort();
  const expected = [...keys].sort();
  return present.length === expected.length && present.every((key, index) => key === expected[index]);
};

const parseGlobalTimer = (input: unknown): GlobalTimer | null => {
  if (!isRecord(input) || !exactKeys(input, ["totalMs", "endsAt", "pausedRemainMs"])) return null;
  if (
    !isTimerTotalMs(input.totalMs) ||
    input.totalMs === null ||
    !(input.endsAt === null || isInstant(input.endsAt)) ||
    !isPausedRemainMs(input.pausedRemainMs)
  ) return null;
  if (input.endsAt !== null && input.pausedRemainMs !== null) return null;
  if (input.pausedRemainMs !== null && input.pausedRemainMs > input.totalMs) return null;
  return input as unknown as GlobalTimer;
};

const parseSettings = (input: unknown): ChallengeSettings | null => {
  if (
    !isRecord(input) ||
    !exactKeys(input, [
      "styleId",
      "themeMode",
      "surfaceMode",
      "headerTitle",
      "effectsEnabled",
      "maxVisible",
      "themeId",
      "globalTimer",
    ]) ||
    !isChallengeStyleId(input.styleId) ||
    !isThemeMode(input.themeMode) ||
    !isSurfaceMode(input.surfaceMode) ||
    !isHeaderTitle(input.headerTitle) ||
    typeof input.effectsEnabled !== "boolean" ||
    !isMaxVisible(input.maxVisible) ||
    !isThemeId(input.themeId)
  ) return null;

  if (input.globalTimer !== null && parseGlobalTimer(input.globalTimer) === null) return null;
  return input as unknown as ChallengeSettings;
};

const parseChallenge = (input: unknown): Challenge | null => {
  if (
    !isRecord(input) ||
    !exactKeys(input, [
      "id",
      "title",
      "description",
      "targetCount",
      "timerTotalMs",
      "sortOrder",
      "currentCount",
      "state",
      "timerEndsAt",
      "completedAt",
      "createdAt",
      "updatedAt",
    ]) ||
    !isChallengeId(input.id) ||
    !isChallengeTitle(input.title) ||
    !isChallengeDescription(input.description) ||
    !isTargetCount(input.targetCount) ||
    !isTimerTotalMs(input.timerTotalMs) ||
    !isSortOrder(input.sortOrder) ||
    !isCurrentCount(input.currentCount) ||
    !isChallengeState(input.state) ||
    !(input.timerEndsAt === null || isInstant(input.timerEndsAt)) ||
    !(input.completedAt === null || isInstant(input.completedAt)) ||
    !isInstant(input.createdAt) ||
    !isInstant(input.updatedAt)
  ) return null;
  return input as unknown as Challenge;
};

const isChallengeEvent = (input: unknown): input is ChallengeEvent => {
  if (!isRecord(input) || input.scope !== "challenge" || typeof input.type !== "string") return false;
  if (input.type === "progressed") {
    return (
      exactKeys(input, ["scope", "type", "challengeId", "delta", "previousCount", "currentCount"]) &&
      isChallengeId(input.challengeId) &&
      isDelta(input.delta) &&
      isCurrentCount(input.previousCount) &&
      isCurrentCount(input.currentCount)
    );
  }
  return (
    exactKeys(input, ["scope", "type", "challengeId"]) &&
    (input.type === "completed" ||
      input.type === "reopened" ||
      input.type === "timer_started" ||
      input.type === "timer_stopped") &&
    isChallengeId(input.challengeId)
  );
};

const isGlobalTimerEvent = (input: unknown): input is GlobalTimerEvent =>
  isRecord(input) &&
  exactKeys(input, ["scope", "type"]) &&
  input.scope === "global" &&
  (input.type === "global_started" ||
    input.type === "global_paused" ||
    input.type === "global_reset");

export const parseChallengeUpdate = (input: unknown): ChallengeUpdate | null => {
  if (
    !isRecord(input) ||
    !exactKeys(input, [
      "eventSeq",
      "boardRevision",
      "settingsRevision",
      "settings",
      "challenges",
      "event",
    ]) ||
    !isEventSeq(input.eventSeq) ||
    !isRevision(input.boardRevision) ||
    !isRevision(input.settingsRevision)
  ) return null;

  const settings = parseSettings(input.settings);
  if (settings === null) return null;
  if (!Array.isArray(input.challenges) || input.challenges.length > MAX_CHALLENGES) return null;
  const challenges = input.challenges.map(parseChallenge);
  if (challenges.some((challenge) => challenge === null)) return null;
  if (
    input.event !== null &&
    !isChallengeEvent(input.event) &&
    !isGlobalTimerEvent(input.event)
  ) return null;
  return {
    eventSeq: input.eventSeq,
    boardRevision: input.boardRevision,
    settingsRevision: input.settingsRevision,
    settings,
    challenges: challenges as Challenge[],
    event: input.event,
  };
};

export const parseChallengeMessage = (input: unknown): ChallengeMessage | null => {
  if (isRecord(input) && input.type === "token_revoked" && exactKeys(input, ["type"])) {
    return { type: "token_revoked" };
  }
  return parseChallengeUpdate(input);
};

export type CeremonyAccounting = {
  lastSeen: number;
  shouldFire: boolean;
};

export const accountForChallengeUpdate = (
  update: ChallengeUpdate,
  lastSeen: number,
): CeremonyAccounting => ({
  lastSeen: Math.max(lastSeen, update.eventSeq),
  shouldFire: update.event !== null && update.eventSeq > lastSeen,
});
