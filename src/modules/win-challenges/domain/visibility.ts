import type { Challenge } from "../contracts/schemas";
import { deriveChallengeTimerState, type DomainNow } from "./timers";

export type VisibleSelectionOptions = {
  includeHidden?: boolean;
  doneOrder?: "end" | "keep";
};

const bySortOrder = (left: Challenge, right: Challenge): number =>
  left.sortOrder - right.sortOrder;

export const selectVisible = (
  challenges: readonly Challenge[],
  now: DomainNow,
  options: VisibleSelectionOptions = {},
): Challenge[] => {
  const ordered = challenges
    .filter((challenge) => options.includeHidden === true || !challenge.hidden)
    .sort(bySortOrder);
  const pinned = ordered.find(
    (challenge) =>
      challenge.state !== "done" &&
      deriveChallengeTimerState(challenge, now) === "running",
  );
  const withoutPinned = ordered.filter((challenge) => challenge !== pinned);
  const reordered = options.doneOrder === "keep"
    ? withoutPinned
    : [
        ...withoutPinned.filter((challenge) => challenge.state !== "done"),
        ...withoutPinned.filter((challenge) => challenge.state === "done"),
      ];
  const selected = pinned === undefined ? reordered : [pinned, ...reordered];

  return selected;
};

export const challengeNumbers = (challenges: readonly Challenge[]): Map<string, number> => {
  const numbers = new Map<string, number>();
  challenges
    .filter((challenge) => !challenge.hidden)
    .sort(bySortOrder)
    .forEach((challenge, index) => numbers.set(challenge.id, index + 1));
  return numbers;
};

export const formatChallengeStand = (
  challenges: readonly Pick<Challenge, "state" | "hidden">[],
): string => {
  const completed = challenges.filter((challenge) => challenge.state === "done").length;
  const hidden = challenges.filter((challenge) => challenge.hidden).length;
  const visible = challenges.length - hidden;
  return `${String(completed)} / ${String(visible)}${hidden > 0 ? `(+${String(hidden)})` : ""}`;
};
