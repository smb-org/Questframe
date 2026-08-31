import { deriveTimerState, type TimerState } from "../domain/timers";

export const formatRemaining = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (hours > 0) {
    return `${String(hours)}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  return `${String(minutes)}:${String(rest).padStart(2, "0")}`;
};

export const remainingFor = (
  endsAt: string | null,
  pausedRemainMs: number | null,
  state: TimerState,
  now: number,
): number => {
  if (state === "running" && endsAt !== null) return Math.max(0, Date.parse(endsAt) - now);
  if (state === "paused" && pausedRemainMs !== null) return pausedRemainMs;
  return 0;
};

export const timerIsCritical = (state: TimerState, remainingMs: number): boolean =>
  state === "expired" || (state === "running" && remainingMs > 0 && remainingMs < 60_000);

export const challengeTimerState = (
  endsAt: string | null,
  pausedRemainMs: number | null,
  now: number,
): TimerState => deriveTimerState(endsAt, pausedRemainMs, now);
