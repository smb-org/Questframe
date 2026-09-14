export type ChallengeStyleId =
  | "plain-list"
  | "plain-bullets"
  | "quest-log";

export type ChallengeOverflowMode = "cut" | "page" | "scroll";
export type ChallengeOverflowTempo = "slow" | "medium" | "fast";
export type ChallengeDoneOrder = "end" | "keep";
export type GlobalTimerMode = "down" | "up";
export type ChallengeFontFamily = "theme" | "atkinson" | "serif" | "sans" | "mono";
export type ChallengeSurfaceOpacity = 0 | 25 | 50 | 75 | 100;
export type ChallengeTextEmphasis = "auto" | "strong" | "plain";

export type ChallengeThemeId =
  | "trail-wood"
  | "field-journal"
  | "forged-compass"
  | "classic-simple"
  | "modern-compact"
  | "modern-minimal";

export type ChallengeState = "pending" | "active" | "done";
export type ChallengeKind = "tick" | "counter" | "streak" | "measure";

export type Challenge = {
  id: string;
  title: string;
  kind: ChallengeKind;
  unit: string | null;
  controlKey: string;
  targetCount: number | null;
  timerTotalMs: number | null;
  sortOrder: number;
  step: number;
  bestCount: number;
  hidden: boolean;
  currentCount: number;
  state: ChallengeState;
  timerEndsAt: string | null;
  timerRemainMs: number | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GlobalTimer = {
  totalMs: number;
  endsAt: string | null;
  pausedRemainMs: number | null;
};

export type ChallengePlacement = {
  x: number;
  y: number;
  scale: number;
};

export type ChallengeSettings = {
  styleId: ChallengeStyleId;
  themeMode: "inherit" | "own";
  surfaceOpacity: ChallengeSurfaceOpacity;
  headerStyle: "default" | "inverted";
  textEmphasis: ChallengeTextEmphasis;
  fontFamily: ChallengeFontFamily;
  fontScale: number;
  headerTitle: string;
  penaltyLabel: string;
  penaltyText: string;
  effectsEnabled: boolean;
  maxVisible: number;
  overflowMode: ChallengeOverflowMode;
  overflowTempo: ChallengeOverflowTempo;
  numbered: boolean;
  doneOrder: ChallengeDoneOrder;
  globalTimerMode: GlobalTimerMode;
  themeId: ChallengeThemeId;
  globalTimer: GlobalTimer | null;
  placement: ChallengePlacement;
};

export type ChallengeEventType =
  | "progressed"
  | "completed"
  | "reopened"
  | "timer_started"
  | "timer_stopped"
  | "streak-reset";

export type ChallengeEvent =
  | {
      scope: "challenge";
      type: "progressed";
      challengeId: string;
      delta: number;
      previousCount: number;
      currentCount: number;
    }
  | {
      scope: "challenge";
      type: Exclude<ChallengeEventType, "progressed">;
      challengeId: string;
    };

export type GlobalTimerEventType =
  | "global_started"
  | "global_paused"
  | "global_reset";

export type GlobalTimerEvent = {
  scope: "global";
  type: GlobalTimerEventType;
};

export type ChallengeUpdate = {
  eventSeq: number;
  boardRevision: number;
  settingsRevision: number;
  settings: ChallengeSettings;
  challenges: Challenge[];
  event: ChallengeEvent | GlobalTimerEvent | null;
};
