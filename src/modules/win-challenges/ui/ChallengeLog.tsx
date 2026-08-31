import type { CSSProperties } from "react";

import type {
  Challenge,
  ChallengeUpdate,
  GlobalTimer,
} from "../../../shared/contracts/win-challenges";
import { selectVisible } from "../domain/visibility";
import { deriveTimerState, type TimerState } from "../domain/timers";
import {
  formatRemaining,
  remainingFor,
  timerIsCritical,
} from "./timer";
import "../../../challenges/challenge-source.css";

const timerClass = (state: TimerState, remainingMs: number): string => {
  if (state === "paused") return "challenge-source__timer--paused";
  if (state === "expired") return "challenge-source__timer--expired";
  return remainingMs > 0 && remainingMs < 60_000
    ? "challenge-source__timer--critical"
    : "";
};

export const GlobalTimerRow = ({ timer, now }: { timer: GlobalTimer; now: number }) => {
  const state = deriveTimerState(timer.endsAt, timer.pausedRemainMs, now);
  const remainingMs = remainingFor(timer.endsAt, timer.pausedRemainMs, state, now);
  const critical = timerIsCritical(state, remainingMs);
  const statusLabel = state === "paused"
    ? "pausiert"
    : state === "expired"
      ? "abgelaufen"
      : critical
        ? "kritisch"
        : null;
  return (
    <div
      aria-label={`Globaler Timer: ${formatRemaining(remainingMs)}${statusLabel === null ? "" : `, ${statusLabel}`}`}
      className={`challenge-source__timer ${timerClass(state, remainingMs)}`}
      data-critical={critical ? "true" : "false"}
      data-state={state}
    >
      <span aria-hidden="true">{state === "paused" ? "Ⅱ" : critical ? "!" : "▸"}</span>
      <span>{formatRemaining(remainingMs)}</span>
      {statusLabel !== null && <span className="challenge-source__timer-label">{statusLabel}</span>}
    </div>
  );
};

const ChallengeRow = ({ challenge, now }: { challenge: Challenge; now: number }) => {
  const done = challenge.state === "done";
  const timerState = challenge.timerEndsAt === null
    ? "idle"
    : deriveTimerState(challenge.timerEndsAt, null, now);
  const remainingMs = remainingFor(challenge.timerEndsAt, null, timerState, now);
  const targetCount = challenge.targetCount;
  const progress = targetCount === null
    ? null
    : Math.min(100, Math.max(0, challenge.currentCount / targetCount * 100));
  const progressStyle = progress === null
    ? undefined
    : { "--wc-progress": `${String(progress)}%` } as CSSProperties;
  return (
    <div
      className={`challenge-source__row${done ? " challenge-source__row--done" : ""}`}
      data-challenge-id={challenge.id}
      data-state={challenge.state}
    >
      <span aria-hidden="true" className="challenge-source__mark">{done ? "✓" : "▸"}</span>
      <span className="challenge-source__content">
        <span className="challenge-source__name">{challenge.title}</span>
        {progress !== null && (
          <span
            aria-label={`Fortschritt: ${String(challenge.currentCount)} von ${String(targetCount)}`}
            aria-valuemax={targetCount ?? undefined}
            aria-valuemin={0}
            aria-valuenow={challenge.currentCount}
            className="challenge-source__progress"
            role="progressbar"
            style={progressStyle}
          >
            <span className="challenge-source__progress-fill" />
          </span>
        )}
      </span>
      <span className="challenge-source__meta">
        {challenge.targetCount !== null && (
          <span className="challenge-source__count">{challenge.currentCount} / {challenge.targetCount}</span>
        )}
        {challenge.timerEndsAt !== null && (
          <span className="challenge-source__time">{formatRemaining(remainingMs)}</span>
        )}
      </span>
    </div>
  );
};

export const ChallengeLog = ({ update, now }: { update: ChallengeUpdate; now: number }) => {
  const selection = selectVisible(update.challenges, update.settings.maxVisible, now);
  const globalTimer = update.settings.globalTimer;
  const maxRowsWithoutOverflow = globalTimer === null ? 8 : 7;
  const hasOverflow =
    selection.remaining > 0 || selection.challenges.length > maxRowsWithoutOverflow;
  const maxRows = hasOverflow ? maxRowsWithoutOverflow - 1 : maxRowsWithoutOverflow;
  const challenges = selection.challenges.slice(0, maxRows);
  const omittedOpen = selection.challenges
    .slice(maxRows)
    .filter((challenge) => challenge.state !== "done").length;
  const remaining = selection.remaining + omittedOpen;
  const globalState = globalTimer === null
    ? "idle"
    : deriveTimerState(globalTimer.endsAt, globalTimer.pausedRemainMs, now);

  // Ein langer fertiger Nachhall gilt ohne aktiven globalen Zustand als leer.
  if (challenges.length === 0 && (globalTimer === null || globalState === "idle")) return null;

  const completed = update.challenges.filter((challenge) => challenge.state === "done").length;
  return (
    <main
      aria-label="Challenge-Quelle"
      className={`challenge-source${update.settings.themeMode === "inherit" ? ` hud-theme--${update.settings.themeId}` : ""}`}
      data-style={update.settings.styleId}
      data-surface-mode={update.settings.surfaceMode}
      data-theme-mode={update.settings.themeMode}
      data-theme-id={update.settings.themeId}
    >
      <header className="challenge-source__header">
        <span className="challenge-source__title">{update.settings.headerTitle}</span>
        <span className="challenge-source__stand">{completed} / {update.challenges.length}</span>
      </header>
      {globalTimer !== null && <GlobalTimerRow now={now} timer={globalTimer} />}
      {challenges.length > 0 && (
        <section aria-label="Challenges" className="challenge-source__rows">
          {challenges.map((challenge) => <ChallengeRow key={challenge.id} challenge={challenge} now={now} />)}
          {remaining > 0 && <p className="challenge-source__more">+{remaining} weitere</p>}
        </section>
      )}
    </main>
  );
};
