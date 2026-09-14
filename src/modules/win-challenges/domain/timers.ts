import type { Challenge, GlobalTimer } from "../contracts/schemas";
import type { ChallengeEvent, GlobalTimerEvent } from "../contracts/events";
import { maxCountForKind, maxDeltaForKind } from "../contracts/predicates";

export type DomainNow = number | string;
export type TimerState = "idle" | "running" | "paused" | "expired";
export const DOMAIN_ERROR_MESSAGES = {
  challenge_timer_not_configured: "Für diese Challenge ist kein Timer eingerichtet.",
  global_timer_not_configured: "Für den globalen Timer ist keine Dauer eingerichtet.",
} as const;

export type DomainError = keyof typeof DOMAIN_ERROR_MESSAGES;

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

export const deriveChallengeTimerState = (
  challenge: Pick<Challenge, "timerEndsAt" | "timerRemainMs">,
  now: DomainNow,
): TimerState => deriveTimerState(challenge.timerEndsAt, challenge.timerRemainMs, now);

const withChallengeTimestamp = (now: DomainNow): Pick<Challenge, "updatedAt"> => ({
  updatedAt: toInstant(now),
});

const completeChallenge = (challenge: Challenge, now: DomainNow): Challenge => {
  const timerState = deriveChallengeTimerState(challenge, now);
  const timerRemainMs = timerState === "running" && challenge.timerEndsAt !== null
    ? Date.parse(challenge.timerEndsAt) - toMilliseconds(now)
    : timerState === "paused"
      ? challenge.timerRemainMs
      : timerState === "expired" && challenge.timerEndsAt !== null
        ? Date.parse(challenge.timerEndsAt) - toMilliseconds(now)
        : null;
  return {
    ...challenge,
    bestCount: Math.max(challenge.bestCount, challenge.currentCount),
    state: "done",
    timerEndsAt: null,
    timerRemainMs,
    completedAt: toInstant(now),
    hidden: false,
    ...withChallengeTimestamp(now),
  };
};

export function applyIncrement(
  challenge: Challenge,
  delta: number,
  now: DomainNow,
): ChallengeTransition {
  if (challenge.state === "done" || !Number.isFinite(delta)) {
    return { challenge, event: null };
  }

  const boundedDelta = Math.max(
    -maxDeltaForKind(challenge.kind),
    Math.min(maxDeltaForKind(challenge.kind), Math.trunc(delta)),
  );
  const maximum = challenge.kind === "measure"
    ? maxCountForKind(challenge.kind)
    : challenge.targetCount ?? maxCountForKind(challenge.kind);
  const nextCount = Math.max(0, Math.min(maximum, challenge.currentCount + boundedDelta));
  if (nextCount === challenge.currentCount) {
    return { challenge, event: null };
  }

  const nextBestCount = Math.max(challenge.bestCount, challenge.currentCount, nextCount);

  if (challenge.kind !== "measure" && challenge.targetCount !== null && nextCount === challenge.targetCount) {
    return {
      challenge: completeChallenge({ ...challenge, currentCount: nextCount, bestCount: nextBestCount }, now),
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
      bestCount: nextBestCount,
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

export function applyResetStreak(
  challenge: Challenge,
  now: DomainNow,
): ChallengeTransition {
  return {
    challenge: {
      ...challenge,
      currentCount: 0,
      ...withChallengeTimestamp(now),
    },
    event: {
      scope: "challenge",
      type: "streak-reset",
      challengeId: challenge.id,
    },
  };
}

export function applyComplete(
  challenge: Challenge,
  now: DomainNow,
): ChallengeTransition {
  if (challenge.state === "done") return { challenge, event: null };
  return {
    challenge: completeChallenge(challenge, now),
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
  return {
    challenge: {
      ...challenge,
      state: "pending",
      timerEndsAt: null,
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
  const timerState = deriveChallengeTimerState(challenge, now);
  if (timerState === "running") {
    return { challenge, event: null };
  }
  if (timerState === "paused" && challenge.timerRemainMs !== null) {
    return {
      challenge: {
        ...challenge,
        state: "active",
        timerEndsAt: addMilliseconds(now, challenge.timerRemainMs),
        timerRemainMs: null,
        ...withChallengeTimestamp(now),
      },
      event: {
        scope: "challenge",
        type: "timer_started",
        challengeId: challenge.id,
      },
    };
  }
  if (challenge.timerTotalMs === null) {
    return { challenge, event: null, error: "challenge_timer_not_configured" };
  }
  return {
    challenge: {
      ...challenge,
      state: "active",
      timerEndsAt: addMilliseconds(now, challenge.timerTotalMs),
      timerRemainMs: null,
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
  const timerState = deriveChallengeTimerState(challenge, now);
  if (timerState !== "running" && timerState !== "expired") return { challenge, event: null };
  const timerRemainMs = challenge.timerEndsAt === null
    ? null
    : Date.parse(challenge.timerEndsAt) - toMilliseconds(now);
  return {
    challenge: {
      ...challenge,
      state: "pending",
      timerEndsAt: null,
      timerRemainMs,
      ...withChallengeTimestamp(now),
    },
    event: {
      scope: "challenge",
      type: "timer_stopped",
      challengeId: challenge.id,
    },
  };
}

export function applyResetTimer(
  challenge: Challenge,
  now: DomainNow,
): ChallengeTransition {
  if (challenge.state === "done") return { challenge, event: null };
  if (deriveChallengeTimerState(challenge, now) === "idle") return { challenge, event: null };
  return {
    challenge: {
      ...challenge,
      state: "pending",
      timerEndsAt: null,
      timerRemainMs: null,
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
    return { globalTimer, event: null, error: "global_timer_not_configured" };
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
  const timerState = deriveTimerState(globalTimer.endsAt, globalTimer.pausedRemainMs, now);
  if (timerState !== "running" && timerState !== "expired") {
    return { globalTimer, event: null };
  }
  const endsAt = globalTimer.endsAt;
  if (endsAt === null) return { globalTimer, event: null };
  const pausedRemainMs = Date.parse(endsAt) - toMilliseconds(now);
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
