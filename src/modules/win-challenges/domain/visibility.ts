import type { Challenge } from "../contracts/schemas";
import { MAX_TOTAL_ROWS } from "../contracts/predicates";
import { deriveTimerState, type DomainNow } from "./timers";

export type VisibleSelection = {
  challenges: Challenge[];
  remaining: number;
};

export type VisibleSelectionOptions = {
  includeHidden?: boolean;
};

const bySortOrder = (left: Challenge, right: Challenge): number =>
  left.sortOrder - right.sortOrder;

export const selectVisible = (
  challenges: readonly Challenge[],
  maxVisible: number,
  now: DomainNow,
  options: VisibleSelectionOptions = {},
): VisibleSelection => {
  const ordered = challenges
    .filter((challenge) => options.includeHidden === true || !challenge.hidden)
    .sort(bySortOrder);
  const open = ordered.filter((challenge) => challenge.state !== "done");
  const finished = ordered.filter((challenge) => challenge.state === "done");

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
    remaining: ordered.length - visibleOpen.length - visibleFinished.length,
  };
};

export const formatChallengeStand = (
  challenges: readonly Pick<Challenge, "state" | "hidden">[],
): string => {
  const completed = challenges.filter((challenge) => challenge.state === "done").length;
  const hidden = challenges.filter((challenge) => challenge.hidden).length;
  const visible = challenges.length - hidden;
  return `${String(completed)} / ${String(visible)}${hidden > 0 ? `(+${String(hidden)})` : ""}`;
};
