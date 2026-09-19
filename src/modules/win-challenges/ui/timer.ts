import { deriveTimerState, type TimerState } from "../domain/timers";
import type { GlobalTimerMode } from "../../../shared/contracts/win-challenges";

export const formatRemaining = (milliseconds: number): string => {
  const overtime = milliseconds < 0;
  const seconds = Math.ceil(Math.abs(milliseconds) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  const prefix = overtime ? "+" : "";
  if (hours > 0) {
    return `${prefix}${String(hours)}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  return `${prefix}${String(minutes)}:${String(rest).padStart(2, "0")}`;
};

export const displayedMsFor = (
  mode: GlobalTimerMode,
  totalMs: number,
  remainingMs: number,
): number => {
  if (mode === "down") return Math.min(totalMs, remainingMs);
  return Math.min(totalMs, Math.max(0, totalMs - remainingMs));
};

export const remainingFor = (
  endsAt: string | null,
  pausedRemainMs: number | null,
  state: TimerState,
  now: number,
): number => {
  if ((state === "running" || state === "expired") && endsAt !== null) {
    return Date.parse(endsAt) - now;
  }
  if (state === "paused" && pausedRemainMs !== null) return pausedRemainMs;
  return 0;
};

export const timerIsCritical = (
  state: TimerState,
  remainingMs: number,
  mode: GlobalTimerMode = "down",
): boolean =>
  mode === "down" && state === "running" && remainingMs > 0 && remainingMs < 60_000;

export const challengeTimerState = (
  endsAt: string | null,
  pausedRemainMs: number | null,
  now: number,
): TimerState => deriveTimerState(endsAt, pausedRemainMs, now);
