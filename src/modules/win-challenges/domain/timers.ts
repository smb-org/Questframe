import type { Challenge, GlobalTimer } from "../contracts/schemas";
import type { ChallengeEvent, GlobalTimerEvent } from "../contracts/events";

export type DomainNow = number | string;
export type TimerState = "idle" | "running" | "paused" | "expired";
export type DomainError = "validation_failed";

export type ChallengeTransition = {
  challenge: Challenge;
  event: ChallengeEvent | null;
  error?: DomainError;
};

export type GlobalTimerTransition = {
  globalTimer: GlobalTimer | null;
  event: GlobalTimerEvent | null;
  error?: DomainError;
};

const toMilliseconds = (now: DomainNow): number => {
  const milliseconds = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError("now muss ein gültiger Zeitpunkt sein.");
  }
  return milliseconds;
};

const toInstant = (now: DomainNow): string =>
  new Date(toMilliseconds(now)).toISOString();

const addMilliseconds = (now: DomainNow, milliseconds: number): string =>
  new Date(toMilliseconds(now) + milliseconds).toISOString();

/** Die eine Ablaufableitung für Challenge- und globalen Timer. */
export const deriveTimerState = (
  endsAt: string | null,
  pausedRemainMs: number | null,
  now: DomainNow,
): TimerState => {
  if (endsAt !== null) {
    return Date.parse(endsAt) > toMilliseconds(now) ? "running" : "expired";
  }
  return pausedRemainMs === null ? "idle" : "paused";
};

const withChallengeTimestamp = (now: DomainNow): Pick<Challenge, "updatedAt"> => ({
  updatedAt: toInstant(now),
});

export function applyIncrement(
  challenge: Challenge,
  delta: number,
  now: DomainNow,
): ChallengeTransition {
  if (challenge.state === "done" || !Number.isFinite(delta)) {
    return { challenge, event: null };
  }

  const boundedDelta = Math.max(-99, Math.min(99, Math.trunc(delta)));
  const maximum = challenge.targetCount ?? 999;
  const nextCount = Math.max(0, Math.min(maximum, challenge.currentCount + boundedDelta));
  if (nextCount === challenge.currentCount) {
    return { challenge, event: null };
  }

  const timestamp = toInstant(now);
  if (challenge.targetCount !== null && nextCount === challenge.targetCount) {
    return {
      challenge: {
        ...challenge,
        currentCount: nextCount,
        state: "done",
        completedAt: timestamp,
        ...withChallengeTimestamp(now),
      },
      event: {
        scope: "challenge",
        type: "completed",
        challengeId: challenge.id,
      },
    };
  }

  return {
    challenge: {
      ...challenge,
      currentCount: nextCount,
      ...withChallengeTimestamp(now),
    },
    event: {
      scope: "challenge",
      type: "progressed",
      challengeId: challenge.id,
      delta: nextCount - challenge.currentCount,
      previousCount: challenge.currentCount,
      currentCount: nextCount,
    },
  };
}

export function applyComplete(
  challenge: Challenge,
  now: DomainNow,
): ChallengeTransition {
  if (challenge.state === "done") return { challenge, event: null };
  const timestamp = toInstant(now);
  return {
    challenge: {
      ...challenge,
      state: "done",
      completedAt: timestamp,
      ...withChallengeTimestamp(now),
    },
    event: {
      scope: "challenge",
      type: "completed",
      challengeId: challenge.id,
    },
  };
}

export function applyReopen(
  challenge: Challenge,
  now: DomainNow,
): ChallengeTransition {
  if (challenge.state !== "done") return { challenge, event: null };
  const nextState =
    deriveTimerState(challenge.timerEndsAt, null, now) === "running"
      ? "active"
      : "pending";
  return {
    challenge: {
      ...challenge,
      state: nextState,
      timerEndsAt: nextState === "active" ? challenge.timerEndsAt : null,
      completedAt: null,
      ...withChallengeTimestamp(now),
    },
    event: {
      scope: "challenge",
      type: "reopened",
      challengeId: challenge.id,
    },
  };
}

export function applyStartTimer(
  challenge: Challenge,
  now: DomainNow,
): ChallengeTransition {
  if (challenge.state === "done") return { challenge, event: null };
  if (deriveTimerState(challenge.timerEndsAt, null, now) === "running") {
    return { challenge, event: null };
  }
  if (challenge.timerTotalMs === null) {
    return { challenge, event: null, error: "validation_failed" };
  }
  return {
    challenge: {
      ...challenge,
      state: "active",
      timerEndsAt: addMilliseconds(now, challenge.timerTotalMs),
      ...withChallengeTimestamp(now),
    },
    event: {
      scope: "challenge",
      type: "timer_started",
      challengeId: challenge.id,
    },
  };
}

export function applyStopTimer(
  challenge: Challenge,
  now: DomainNow,
): ChallengeTransition {
  if (challenge.state !== "active") return { challenge, event: null };
  return {
    challenge: {
      ...challenge,
      state: "pending",
      timerEndsAt: null,
      ...withChallengeTimestamp(now),
    },
    event: {
      scope: "challenge",
      type: "timer_stopped",
      challengeId: challenge.id,
    },
  };
}

const globalEvent = (type: GlobalTimerEvent["type"]): GlobalTimerEvent => ({
  scope: "global",
  type,
});

export const applyStartGlobal = (
  globalTimer: GlobalTimer | null,
  now: DomainNow,
): GlobalTimerTransition => {
  if (globalTimer === null) {
    return { globalTimer, event: null, error: "validation_failed" };
  }

  const state = deriveTimerState(globalTimer.endsAt, globalTimer.pausedRemainMs, now);
  if (state === "running") return { globalTimer, event: null };

  const duration = state === "paused" ? globalTimer.pausedRemainMs : globalTimer.totalMs;
  return {
    globalTimer: {
      ...globalTimer,
      endsAt: addMilliseconds(now, duration ?? globalTimer.totalMs),
      pausedRemainMs: null,
    },
    event: globalEvent("global_started"),
  };
};

export const applyPauseGlobal = (
  globalTimer: GlobalTimer | null,
  now: DomainNow,
): GlobalTimerTransition => {
  if (globalTimer === null) return { globalTimer, event: null };
  if (deriveTimerState(globalTimer.endsAt, globalTimer.pausedRemainMs, now) !== "running") {
    return { globalTimer, event: null };
  }
  const endsAt = globalTimer.endsAt;
  if (endsAt === null) return { globalTimer, event: null };
  const pausedRemainMs = Math.max(0, Date.parse(endsAt) - toMilliseconds(now));
  return {
    globalTimer: { ...globalTimer, endsAt: null, pausedRemainMs },
    event: globalEvent("global_paused"),
  };
};

export const applyResetGlobal = (
  globalTimer: GlobalTimer | null,
  now: DomainNow,
): GlobalTimerTransition => {
  if (globalTimer === null) return { globalTimer, event: null };
  if (deriveTimerState(globalTimer.endsAt, globalTimer.pausedRemainMs, now) === "idle") {
    return { globalTimer, event: null };
  }
  return {
    globalTimer: { ...globalTimer, endsAt: null, pausedRemainMs: null },
    event: globalEvent("global_reset"),
  };
};
