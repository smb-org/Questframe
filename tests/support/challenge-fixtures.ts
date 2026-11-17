import type { ChallengeUpdate } from "../../src/shared/contracts/win-challenges";

export const challengeUpdateSettings = (
  overrides: Partial<ChallengeUpdate["settings"]> = {},
): ChallengeUpdate["settings"] => ({
  styleId: "plain-list",
  themeMode: "own",
  surfaceOpacity: 100,
  headerStyle: "default",
  textEmphasis: "auto",
  fontFamily: "theme",
  fontScale: 1,
  headerTitle: "CHALLENGES",
  penaltyLabel: "STRAFE",
  penaltyText: "",
  effectsEnabled: true,
  maxVisible: 5,
  overflowMode: "cut",
  overflowTempo: "medium",
  numbered: false,
  keyVisible: false,
  doneOrder: "end",
  globalTimerMode: "down",
  globalTimer: null,
  placement: { x: 300, y: 8, scale: 1 },
  ...overrides,
});
