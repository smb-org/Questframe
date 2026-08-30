import type { Challenge } from "../contracts/schemas";
import {
  COMPLETED_VISIBILITY_MS,
  MAX_TOTAL_ROWS,
} from "../contracts/predicates";
import { deriveTimerState, type DomainNow } from "./timers";

export type VisibleSelection = {
  challenges: Challenge[];
  remaining: number;
};

const toMilliseconds = (now: DomainNow): number => {
  const milliseconds = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError("now muss ein gültiger Zeitpunkt sein.");
  }
  return milliseconds;
};

const bySortOrder = (left: Challenge, right: Challenge): number =>
  left.sortOrder - right.sortOrder;

export const selectVisible = (
  challenges: readonly Challenge[],
  maxVisible: number,
  now: DomainNow,
): VisibleSelection => {
  const nowMilliseconds = toMilliseconds(now);
  const ordered = [...challenges].sort(bySortOrder);
  const open = ordered.filter((challenge) => challenge.state !== "done");
  const finished = ordered.filter((challenge) => {
    if (challenge.state !== "done" || challenge.completedAt === null) return false;
    return nowMilliseconds - Date.parse(challenge.completedAt) < COMPLETED_VISIBILITY_MS;
  });

  const pinned = open.find(
    (challenge) =>
      challenge.timerEndsAt !== null &&
      deriveTimerState(challenge.timerEndsAt, null, now) === "running",
  );
  const visibleOpen = [
    ...(pinned === undefined ? [] : [pinned]),
    ...open.filter((challenge) => challenge !== pinned),
  ].slice(0, maxVisible);
  const visibleFinished = finished.slice(0, MAX_TOTAL_ROWS - visibleOpen.length);

  return {
    challenges: [...visibleOpen, ...visibleFinished],
    remaining: open.length - visibleOpen.length,
  };
};
