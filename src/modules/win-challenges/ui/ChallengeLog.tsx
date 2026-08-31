import type { CSSProperties, KeyboardEventHandler, PointerEventHandler } from "react";

import type {
  Challenge,
  ChallengeUpdate,
  GlobalTimer,
} from "../../../shared/contracts/win-challenges";
import { formatChallengeStand, selectVisible } from "../domain/visibility";
import { deriveTimerState, type TimerState } from "../domain/timers";
import {
  formatRemaining,
  remainingFor,
  timerIsCritical,
} from "./timer";

const timerClass = (state: TimerState, remainingMs: number): string => {
  if (state === "paused") return "challenge-source__timer--paused";
  if (state === "expired") return "challenge-source__timer--expired";
  return remainingMs > 0 && remainingMs < 60_000
    ? "challenge-source__timer--critical"
    : "";
};

export type ChallengeLogCeremonyTarget =
  | { kind: "challenge"; id: string }
  | { kind: "global" };

export const GlobalTimerRow = ({
  timer,
  now,
  ceremonyTarget = false,
}: {
  timer: GlobalTimer;
  now: number;
  ceremonyTarget?: boolean;
}) => {
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
      data-ceremony-target={ceremonyTarget ? "true" : undefined}
    >
      <span aria-hidden="true">{state === "paused" ? "Ⅱ" : critical ? "!" : "▸"}</span>
      <span>{formatRemaining(remainingMs)}</span>
      {statusLabel !== null && <span className="challenge-source__timer-label">{statusLabel}</span>}
    </div>
  );
};

const ChallengeRow = ({
  challenge,
  now,
  ceremonyTargetId,
}: {
  challenge: Challenge;
  now: number;
  ceremonyTargetId?: string | null;
}) => {
  const done = challenge.state === "done";
  const timerState = challenge.timerEndsAt === null
    ? "idle"
    : deriveTimerState(challenge.timerEndsAt, null, now);
  const remainingMs = remainingFor(challenge.timerEndsAt, null, timerState, now);
  const targetCount = challenge.targetCount;
  const progress = targetCount === null
    ? null
    : done
      ? 100
      : Math.min(100, Math.max(0, challenge.currentCount / targetCount * 100));
  const progressStyle = progress === null
    ? undefined
    : { "--wc-progress": `${String(progress)}%` } as CSSProperties;
  return (
    <li
      className={`challenge-source__row${done ? " challenge-source__row--done" : ""}`}
      data-challenge-id={challenge.id}
      data-ceremony-target={ceremonyTargetId === challenge.id ? "true" : undefined}
      data-state={challenge.state}
    >
      <span className="challenge-source__row-inner">
        <span aria-hidden="true" className="challenge-source__mark">{done ? "✓" : ""}</span>
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
          {challenge.timerEndsAt !== null && !done && (
            <span className="challenge-source__time">{formatRemaining(remainingMs)}</span>
          )}
        </span>
      </span>
    </li>
  );
};

export const ChallengeLog = ({
  update,
  now,
  ceremonyTarget = null,
  placement,
  className,
  ariaLabel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  onKeyDown,
  rootTag,
}: {
  update: ChallengeUpdate;
  now: number;
  ceremonyTarget?: ChallengeLogCeremonyTarget | null;
  placement?: ChallengeUpdate["settings"]["placement"];
  className?: string;
  ariaLabel?: string;
  onPointerDown?: PointerEventHandler<HTMLElement>;
  onPointerMove?: PointerEventHandler<HTMLElement>;
  onPointerUp?: PointerEventHandler<HTMLElement>;
  onPointerCancel?: PointerEventHandler<HTMLElement>;
  onLostPointerCapture?: PointerEventHandler<HTMLElement>;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  rootTag?: "main" | "section";
}) => {
  const selection = selectVisible(update.challenges, update.settings.maxVisible, now);
  const globalTimer = update.settings.globalTimer;
  const maxRowsWithoutOverflow = globalTimer === null ? 8 : 7;
  const totalSelectable = selection.challenges.length + selection.remaining;
  const hasOverflow = totalSelectable > maxRowsWithoutOverflow;
  const maxRows = hasOverflow ? maxRowsWithoutOverflow - 1 : maxRowsWithoutOverflow;
  const selectedChallenges = selection.challenges.slice(0, maxRows);
  const ceremonyChallenge = ceremonyTarget?.kind === "challenge"
    ? update.challenges.find((challenge) => challenge.id === ceremonyTarget.id) ?? null
    : null;
  const eligibleCeremonyChallenge = ceremonyChallenge !== null && !ceremonyChallenge.hidden
    ? ceremonyChallenge
    : null;
  const ceremonyTargetIsVisible = eligibleCeremonyChallenge !== null
    && selectedChallenges.some((challenge) => challenge.id === eligibleCeremonyChallenge.id);
  // Ein gerade gemeldetes Ziel bleibt sichtbar, auch wenn die normale Auswahl
  // wegen maxVisible oder der festen Zeilenobergrenze einen anderen Ausschnitt zeigt.
  const challenges = eligibleCeremonyChallenge !== null && !ceremonyTargetIsVisible
    ? [...selectedChallenges.slice(0, Math.max(0, selectedChallenges.length - 1)), eligibleCeremonyChallenge]
    : selectedChallenges;
  const remaining = Math.max(0, totalSelectable - challenges.length);
  const globalState = globalTimer === null
    ? "idle"
    : deriveTimerState(globalTimer.endsAt, globalTimer.pausedRemainMs, now);

  if (challenges.length === 0 && (globalTimer === null || globalState === "idle")) return null;

  const placementStyle: CSSProperties = {
    "--wc-x": `${String((placement ?? update.settings.placement).x * 5)}px`,
    "--wc-y": `${String((placement ?? update.settings.placement).y * 5)}px`,
    "--wc-scale": String((placement ?? update.settings.placement).scale),
  } as CSSProperties;
  const Root = rootTag ?? "main";

  return (
    <Root
      aria-label={ariaLabel ?? "Challenge-Quelle"}
      className={`challenge-source${update.settings.themeMode === "inherit" ? ` hud-theme--${update.settings.themeId}` : ""}${className === undefined ? "" : ` ${className}`}`}
      data-style={update.settings.styleId}
      data-surface-mode={update.settings.surfaceMode}
      data-theme-mode={update.settings.themeMode}
      data-theme-id={update.settings.themeId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onKeyDown={onKeyDown}
      tabIndex={ariaLabel === undefined ? undefined : 0}
      style={placementStyle}
    >
      <header className="challenge-source__header">
        <span className="challenge-source__title">{update.settings.headerTitle}</span>
        <span className="challenge-source__stand">{formatChallengeStand(update.challenges)}</span>
      </header>
      {globalTimer !== null && (
        <GlobalTimerRow
          ceremonyTarget={ceremonyTarget?.kind === "global"}
          now={now}
          timer={globalTimer}
        />
      )}
      {challenges.length > 0 && (
        <ul aria-label="Challenges" className="challenge-source__rows">
          {challenges.map((challenge) => (
            <ChallengeRow
              ceremonyTargetId={ceremonyTarget?.kind === "challenge" ? ceremonyTarget.id : null}
              key={challenge.id}
              challenge={challenge}
              now={now}
            />
          ))}
          {remaining > 0 && <li className="challenge-source__more">+{remaining} weitere</li>}
        </ul>
      )}
    </Root>
  );
};
