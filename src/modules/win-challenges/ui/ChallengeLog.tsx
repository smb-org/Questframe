import type { CSSProperties, KeyboardEventHandler, PointerEventHandler } from "react";

import type {
  Challenge,
  ChallengeUpdate,
  GlobalTimer,
} from "../../../shared/contracts/win-challenges";
import { challengeNumbers, formatChallengeStand, selectVisible } from "../domain/visibility";
import { deriveTimerState, type TimerState } from "../domain/timers";
import {
  formatRemaining,
  remainingFor,
  timerIsCritical,
} from "./timer";
import { useScrollOffset } from "./scroll";

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

const GlobalTimerDisplay = ({
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
    <span
      aria-label={`Globaler Timer: ${formatRemaining(remainingMs)}${statusLabel === null ? "" : `, ${statusLabel}`}`}
      className={`challenge-source__timer ${timerClass(state, remainingMs)}`}
      data-critical={critical ? "true" : "false"}
      data-state={state}
      data-ceremony-target={ceremonyTarget ? "true" : undefined}
    >
      <span aria-hidden="true">{state === "paused" ? "Ⅱ" : critical ? "!" : "▸"}</span>
      <span>{formatRemaining(remainingMs)}</span>
      {statusLabel !== null && <span className="challenge-source__timer-label">{statusLabel}</span>}
    </span>
  );
};

const ChallengeRow = ({
  challenge,
  now,
  ceremonyTargetId,
  number,
  numbered,
}: {
  challenge: Challenge;
  now: number;
  ceremonyTargetId?: string | null;
  number: number | undefined;
  numbered: boolean;
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
        <span aria-hidden="true" className="challenge-source__mark">{numbered ? number ?? "" : done ? "✓" : ""}</span>
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
  const selection = selectVisible(update.challenges, now, { doneOrder: update.settings.doneOrder });
  const globalTimer = update.settings.globalTimer;
  const globalState = globalTimer === null
    ? "idle"
    : deriveTimerState(globalTimer.endsAt, globalTimer.pausedRemainMs, now);
  const globalTimerVisible = globalTimer !== null && globalState !== "idle";
  const capacity = update.settings.maxVisible;
  const allChallenges = selection.challenges;
  const pinnedCandidate = allChallenges[0];
  const pinned = pinnedCandidate !== undefined && pinnedCandidate.state !== "done"
    && pinnedCandidate.timerEndsAt !== null
    && deriveTimerState(pinnedCandidate.timerEndsAt, null, now) === "running"
    ? pinnedCandidate
    : null;
  const pageSize = Math.max(1, capacity - (pinned === null ? 0 : 1));
  const pageCount = Math.max(
    1,
    Math.ceil((allChallenges.length - (pinned === null ? 0 : 1)) / pageSize),
  );
  const dwellMs = update.settings.overflowTempo === "slow"
    ? 12_000
    : update.settings.overflowTempo === "fast"
      ? 5_000
      : 8_000;
  const scrollHasOverflow = update.settings.overflowMode === "scroll" && allChallenges.length > capacity;
  const scroll = useScrollOffset({
    ceremonyTargetId: ceremonyTarget?.kind === "challenge"
      ? update.challenges.find((challenge) => challenge.id === ceremonyTarget.id && !challenge.hidden)?.id ?? null
      : null,
    enabled: scrollHasOverflow,
    rowCount: pageSize,
    speedPxPerS: update.settings.overflowTempo === "slow"
      ? 8
      : update.settings.overflowTempo === "fast"
        ? 24
        : 14,
  });
  const effectiveMode = update.settings.overflowMode === "scroll" && scroll.reducedMotion
    ? "page"
    : update.settings.overflowMode;
  const pageIndex = effectiveMode === "page" && pageCount > 1
    ? Math.floor(now / dwellMs) % pageCount
    : 0;
  const restChallenges = pinned === null ? allChallenges : allChallenges.slice(1);
  const selectedChallenges = effectiveMode === "page"
    ? [
        ...(pinned === null ? [] : [pinned]),
        ...restChallenges.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
      ]
    : effectiveMode === "scroll"
      ? allChallenges
      : allChallenges.slice(0, capacity);
  const ceremonyChallenge = ceremonyTarget?.kind === "challenge"
    ? update.challenges.find((challenge) => challenge.id === ceremonyTarget.id) ?? null
    : null;
  const eligibleCeremonyChallenge = ceremonyChallenge !== null && !ceremonyChallenge.hidden
    ? ceremonyChallenge
    : null;
  const numbers = challengeNumbers(update.challenges);
  const ceremonyTargetIsVisible = eligibleCeremonyChallenge !== null
    && selectedChallenges.some((challenge) => challenge.id === eligibleCeremonyChallenge.id);
  // Ein gerade gemeldetes Ziel bleibt auch in der aktuellen Seite bzw. im
  // Ausschnitt sichtbar. Die gepinnte Zeile wird dabei nie ersetzt.
  const ceremonyReplacementIndex = selectedChallenges.length - 1;
  const challenges = eligibleCeremonyChallenge !== null && !ceremonyTargetIsVisible
    && selectedChallenges.length > (pinned === null ? 0 : 1)
    ? [
        ...selectedChallenges.slice(0, Math.max(pinned === null ? 0 : 1, ceremonyReplacementIndex)),
        eligibleCeremonyChallenge,
      ]
    : selectedChallenges;
  const remaining = effectiveMode === "cut"
    ? Math.max(0, allChallenges.length - challenges.length)
    : 0;

  if (challenges.length === 0 && !globalTimerVisible) return null;

  const placementStyle: CSSProperties = {
    "--wc-x": `${String((placement ?? update.settings.placement).x * 5)}px`,
    "--wc-y": `${String((placement ?? update.settings.placement).y * 5)}px`,
    "--wc-scale": String((placement ?? update.settings.placement).scale),
    "--wc-scroll-visible-rows": String(pageSize),
  } as CSSProperties;
  const Root = rootTag ?? "main";

  return (
    <Root
      aria-label={ariaLabel ?? "Challenge-Quelle"}
      className={`challenge-source${update.settings.themeMode === "inherit" ? ` hud-theme--${update.settings.themeId}` : ""}${className === undefined ? "" : ` ${className}`}`}
      data-style={update.settings.styleId}
      data-overflow-mode={effectiveMode}
      data-numbered={update.settings.numbered ? "true" : "false"}
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
        {globalTimerVisible && (
          <GlobalTimerDisplay
            ceremonyTarget={ceremonyTarget?.kind === "global"}
            now={now}
            timer={globalTimer}
          />
        )}
        <span className="challenge-source__stand">
          {formatChallengeStand(update.challenges)}
          {effectiveMode === "page" && pageCount > 1 && <span className="challenge-source__page"> · {pageIndex + 1}/{pageCount}</span>}
        </span>
      </header>
      {challenges.length > 0 && effectiveMode === "scroll" && scrollHasOverflow && (
        <>
          {pinned !== null && <ul aria-label="Gepinnte Challenge" className="challenge-source__rows challenge-source__pinned-row">
            <ChallengeRow
              ceremonyTargetId={ceremonyTarget?.kind === "challenge" ? ceremonyTarget.id : null}
              challenge={pinned}
              numbered={update.settings.numbered}
              number={numbers.get(pinned.id)}
              now={now}
            />
          </ul>}
          {/* The hook owns these callback refs so its animation loop can read the DOM only in effects. */}
          {/* eslint-disable-next-line react-hooks/refs */}
          <div className="challenge-source__scroll-viewport" ref={scroll.viewport}>
            {/* eslint-disable-next-line react-hooks/refs */}
            <ul aria-label="Challenges" className="challenge-source__rows" ref={scroll.rows}>
              {(pinned === null ? allChallenges : allChallenges.slice(1)).map((challenge) => (
                <ChallengeRow
                  ceremonyTargetId={ceremonyTarget?.kind === "challenge" ? ceremonyTarget.id : null}
                  challenge={challenge}
                  key={challenge.id}
                  numbered={update.settings.numbered}
                  number={numbers.get(challenge.id)}
                  now={now}
                />
              ))}
            </ul>
          </div>
        </>
      )}
      {challenges.length > 0 && effectiveMode === "scroll" && !scrollHasOverflow && (
        <ul aria-label="Challenges" className="challenge-source__rows">
          {challenges.map((challenge) => (
            <ChallengeRow
              ceremonyTargetId={ceremonyTarget?.kind === "challenge" ? ceremonyTarget.id : null}
              challenge={challenge}
              key={challenge.id}
              numbered={update.settings.numbered}
              number={numbers.get(challenge.id)}
              now={now}
            />
          ))}
        </ul>
      )}
      {challenges.length > 0 && effectiveMode !== "scroll" && (
        <ul aria-label="Challenges" className="challenge-source__rows" key={effectiveMode === "page" ? pageIndex : "cut"}>
          {challenges.map((challenge) => (
            <ChallengeRow
              ceremonyTargetId={ceremonyTarget?.kind === "challenge" ? ceremonyTarget.id : null}
              key={challenge.id}
              challenge={challenge}
              numbered={update.settings.numbered}
              number={numbers.get(challenge.id)}
              now={now}
            />
          ))}
          {effectiveMode === "cut" && remaining > 0 && <li className="challenge-source__more">+{remaining} weitere</li>}
        </ul>
      )}
    </Root>
  );
};
