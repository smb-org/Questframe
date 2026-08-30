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
