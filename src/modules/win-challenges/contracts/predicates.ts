import type { ChallengePlacement } from "../../../shared/contracts/win-challenges";

const challengeGraphemeSegmenter = new Intl.Segmenter("de", {
  granularity: "grapheme",
});

export const MAX_CHALLENGES = 30 as const;
export const MAX_COUNT = 999 as const;
export const GLOBAL_TIMER_UP_CAP_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_CHALLENGE_PLACEMENT = {
  x: 300,
  y: 8,
  scale: 1,
} as const satisfies ChallengePlacement;

export const CHALLENGE_STYLE_IDS = [
  "plain-list",
  "plain-bullets",
  "quest-log",
] as const;

export const CHALLENGE_THEME_IDS = [
  "trail-wood",
  "field-journal",
  "forged-compass",
  "classic-simple",
  "modern-compact",
  "modern-minimal",
] as const;

const graphemeLength = (value: string): number =>
  [...challengeGraphemeSegmenter.segment(value)].length;

export const normalizeChallengeText = (value: string): string =>
  value.normalize("NFC").trim();

const isNormalizedText = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is string => {
  if (typeof value !== "string") return false;
  const normalized = normalizeChallengeText(value);
  return (
    graphemeLength(normalized) >= minimum &&
    graphemeLength(normalized) <= maximum &&
    normalized.length <= maximum
  );
};

export const isChallengeTitle = (value: unknown): value is string =>
  isNormalizedText(value, 1, 160);

export const isHidden = (value: unknown): value is boolean =>
  typeof value === "boolean";

export const isTargetCount = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_COUNT);

export const isCurrentCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;

export const isTimerTotalMs = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 10_000 &&
    value <= 21_600_000);

export const isGlobalTimerTotalMs = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 10_000 &&
    value <= GLOBAL_TIMER_UP_CAP_MS);

export const isDelta = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= -99 && value <= 99;

export const isInstant = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    )
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
};

export const isSortOrder = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value < MAX_CHALLENGES;

export const isMaxVisible = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 3 && value <= 10;

export const isOverflowMode = (value: unknown): value is "cut" | "page" | "scroll" =>
  value === "cut" || value === "page" || value === "scroll";

export const isOverflowTempo = (value: unknown): value is "slow" | "medium" | "fast" =>
  value === "slow" || value === "medium" || value === "fast";

export const isNumbered = (value: unknown): value is boolean =>
  typeof value === "boolean";

export const isDoneOrder = (value: unknown): value is "end" | "keep" =>
  value === "end" || value === "keep";

export const isGlobalTimerMode = (value: unknown): value is "down" | "up" =>
  value === "down" || value === "up";

export const isPlacementX = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 384;

export const isPlacementY = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 216;

export const isPlacementScale = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0.75 &&
  value <= 2 &&
  Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

export const isChallengePlacement = (value: unknown): value is ChallengePlacement =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  isPlacementX((value as { x?: unknown }).x) &&
  isPlacementY((value as { y?: unknown }).y) &&
  isPlacementScale((value as { scale?: unknown }).scale);

export const isHeaderTitle = (value: unknown): value is string =>
  isNormalizedText(value, 1, 24);

export const isChallengeId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const isClientId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const isCommandId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export const isChallengeState = (
  value: unknown,
): value is "pending" | "active" | "done" =>
  value === "pending" || value === "active" || value === "done";

export const isChallengeStyleId = (value: unknown): value is (typeof CHALLENGE_STYLE_IDS)[number] =>
  typeof value === "string" &&
  (CHALLENGE_STYLE_IDS as readonly string[]).includes(value);

export const isThemeId = (value: unknown): value is (typeof CHALLENGE_THEME_IDS)[number] =>
  typeof value === "string" &&
  (CHALLENGE_THEME_IDS as readonly string[]).includes(value);

export const isThemeMode = (value: unknown): value is "inherit" | "own" =>
  value === "inherit" || value === "own";

export const isSurfaceMode = (value: unknown): value is "surface" | "bare" =>
  value === "surface" || value === "bare";

export const isPausedRemainMs = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= GLOBAL_TIMER_UP_CAP_MS);

export const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

export const isEventSeq = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
