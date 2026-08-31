export type ChallengeStyleId =
  | "plain-list"
  | "plain-bullets"
  | "plain-numbered"
  | "quest-log";

export type ChallengeThemeId =
  | "trail-wood"
  | "field-journal"
  | "forged-compass"
  | "classic-simple"
  | "modern-compact"
  | "modern-minimal";

export type ChallengeState = "pending" | "active" | "done";

export type Challenge = {
  id: string;
  title: string;
  description: string | null;
  targetCount: number | null;
  timerTotalMs: number | null;
  sortOrder: number;
  hidden: boolean;
  currentCount: number;
  state: ChallengeState;
  timerEndsAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GlobalTimer = {
  totalMs: number;
  endsAt: string | null;
  pausedRemainMs: number | null;
};

export type ChallengeSettings = {
  styleId: ChallengeStyleId;
  themeMode: "inherit" | "own";
  surfaceMode: "surface" | "bare";
  headerTitle: string;
  effectsEnabled: boolean;
  maxVisible: number;
  themeId: ChallengeThemeId;
  globalTimer: GlobalTimer | null;
};

export type ChallengeEventType =
  | "progressed"
  | "completed"
  | "reopened"
  | "timer_started"
  | "timer_stopped";

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
