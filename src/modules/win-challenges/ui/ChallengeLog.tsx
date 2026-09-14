import { useMemo, type CSSProperties, type KeyboardEventHandler, type PointerEventHandler } from "react";

import type {
  Challenge,
  ChallengeUpdate,
  GlobalTimer,
} from "../../../shared/contracts/win-challenges";
import { challengeNumbers, formatChallengeStand, selectVisible } from "../domain/visibility";
import { deriveChallengeTimerState, deriveTimerState, type TimerState } from "../domain/timers";
import {
  formatRemaining,
  displayedMsFor,
  remainingFor,
  timerIsCritical,
} from "./timer";
import { useScrollOffset } from "./scroll";

const timerClass = (state: TimerState, critical: boolean, mode: ChallengeUpdate["settings"]["globalTimerMode"]): string => {
  if (state === "paused") return "challenge-source__timer--paused";
  if (state === "expired" && mode === "down") return "challenge-source__timer--expired";
  return critical ? "challenge-source__timer--critical" : "";
};

export type ChallengeLogCeremonyTarget =
  | { kind: "challenge"; id: string }
  | { kind: "global" };

const resolveChallengeTextEmphasis = (
  textEmphasis: ChallengeUpdate["settings"]["textEmphasis"],
  surfaceOpacity: ChallengeUpdate["settings"]["surfaceOpacity"],
): Exclude<ChallengeUpdate["settings"]["textEmphasis"], "auto"> =>
  textEmphasis === "auto" ? surfaceOpacity < 50 ? "strong" : "plain" : textEmphasis;

const GlobalTimerDisplay = ({
  timer,
  mode,
  now,
  ceremonyTarget = false,
  ceremonySeq,
}: {
  timer: GlobalTimer;
  mode: ChallengeUpdate["settings"]["globalTimerMode"];
  now: number;
  ceremonyTarget?: boolean;
  ceremonySeq?: number | undefined;
}) => {
  const state = deriveTimerState(timer.endsAt, timer.pausedRemainMs, now);
  const remainingMs = remainingFor(timer.endsAt, timer.pausedRemainMs, state, now);
  const critical = timerIsCritical(state, remainingMs, mode);
  const displayedMs = displayedMsFor(mode, timer.totalMs, remainingMs);
  const statusLabel = state === "paused"
    ? "pausiert"
    : state === "expired" && mode === "down"
      ? "abgelaufen"
      : critical
        ? "kritisch"
        : null;
  return (
    <span
      key={ceremonyTarget ? ceremonySeq : undefined}
      aria-label={`Globaler Timer: ${formatRemaining(displayedMs)}${statusLabel === null ? "" : `, ${statusLabel}`}${mode === "up" ? ", hochzählend" : ""}`}
      className={`challenge-source__timer ${timerClass(state, critical, mode)}`}
      data-critical={critical ? "true" : "false"}
      data-state={state}
      data-ceremony-target={ceremonyTarget ? "true" : undefined}
    >
      <span aria-hidden="true">{state === "paused" ? "Ⅱ" : critical ? "!" : mode === "up" ? "▴" : "▸"}</span>
      <span>{formatRemaining(displayedMs)}</span>
      {statusLabel !== null && <span className="challenge-source__timer-label">{statusLabel}</span>}
    </span>
  );
};

const ChallengeRow = ({
  challenge,
  now,
  ceremonyTargetId,
  ceremonySeq,
  clockOffsetMs = 0,
  number,
  numbered,
  keyVisible,
  accessibleKey,
}: {
  challenge: Challenge;
  now: number;
  ceremonyTargetId?: string | null;
  ceremonySeq?: number | undefined;
  clockOffsetMs?: number;
  number: number | undefined;
  numbered: boolean;
  keyVisible: boolean;
  accessibleKey: boolean;
}) => {
  const done = challenge.state === "done";
  const showingKey = !done && keyVisible;
  const timerState = deriveChallengeTimerState(challenge, now);
  const remainingMs = remainingFor(challenge.timerEndsAt, challenge.timerRemainMs, timerState, now);
  const drain = useMemo(() => {
    if (challenge.timerTotalMs === null) return null;
    // eslint-disable-next-line react-hooks/purity -- Der Snapshot darf nur bei einem Timerwechsel neu berechnet werden.
    const snapshotNow = Date.now() + clockOffsetMs;
    const restMs = challenge.timerEndsAt !== null
      ? Math.max(0, Date.parse(challenge.timerEndsAt) - snapshotNow)
      : challenge.timerRemainMs ?? 0;
    return {
      "--wc-timer-total": `${String(challenge.timerTotalMs)}ms`,
      "--wc-timer-delay": `-${String(challenge.timerTotalMs - restMs)}ms`,
    };
    // Absicht: kein now in den Abhängigkeiten. Die Werte werden genau dann neu
    // berechnet, wenn der Timer oder der Zeit-Offset wechselt.
  }, [challenge.timerEndsAt, challenge.timerRemainMs, challenge.timerTotalMs, clockOffsetMs]);
  const timerScale = challenge.timerTotalMs === null
    ? 0
    : Math.min(1, Math.max(0, remainingMs / challenge.timerTotalMs));
  const showTime = done
    ? challenge.timerRemainMs !== null
    : timerState === "running" || timerState === "paused" || timerState === "expired";
  const timeText = formatRemaining(remainingMs);
  const targetCount = challenge.targetCount;
  const progress = targetCount === null
    ? null
    : done
      ? 100
      : Math.min(100, Math.max(0, challenge.currentCount / targetCount * 100));
  const accessibleCount = targetCount === null ? null : Math.min(challenge.currentCount, targetCount);
  const accessibleText = targetCount !== null && challenge.currentCount > targetCount
    ? `${String(challenge.currentCount)} von ${String(targetCount)} (übererfüllt)`
    : undefined;
  const progressStyle = progress === null
    ? undefined
    : { "--wc-progress": `${String(progress)}%` } as CSSProperties;
  const ceremonyKey = ceremonyTargetId === challenge.id ? ceremonySeq : undefined;
  return (
    <li
      className={`challenge-source__row${done ? " challenge-source__row--done" : ""}`}
      data-challenge-id={challenge.id}
      data-ceremony-target={ceremonyTargetId === challenge.id ? "true" : undefined}
      data-state={challenge.state}
      data-timer-critical={!done && timerState === "running" && remainingMs < 30_000 ? "true" : undefined}
      data-timer-state={done || timerState === "idle" ? undefined : timerState}
      style={{
        ...drain,
        "--wc-timer-scale": String(timerScale),
      } as CSSProperties}
    >
      <span aria-hidden="true" className="challenge-source__timer-bar" />
      <span className="challenge-source__row-inner" key={ceremonyKey}>
        <span
          aria-hidden={showingKey && accessibleKey ? undefined : true}
          aria-label={showingKey && accessibleKey ? `Steuer-Key ${challenge.controlKey}` : undefined}
          className={`challenge-source__mark${showingKey ? " challenge-source__mark--key" : ""}`}
          key={ceremonyKey}
        >
          {/* Erledigt schlaegt Steuer-Key und Nummerierung: der gruene Haken ist das Signal,
            beide Adressen waeren hier nur noch Buchhaltung. */}
          {done ? "✓" : showingKey ? challenge.controlKey : numbered ? number ?? "" : ""}
        </span>
        <span className="challenge-source__content">
          <span className="challenge-source__name">{challenge.title}</span>
          {progress !== null && (
            <span
              aria-label={`Fortschritt: ${String(challenge.currentCount)} von ${String(targetCount)}`}
              aria-valuemax={targetCount ?? undefined}
              aria-valuemin={0}
              aria-valuenow={accessibleCount ?? undefined}
              aria-valuetext={accessibleText}
              className="challenge-source__progress"
              role="progressbar"
              style={progressStyle}
            >
              <span className="challenge-source__progress-fill" />
            </span>
          )}
        </span>
        <span className="challenge-source__meta">
          {/* Ohne Ziel bleibt der Zaehler ab dem ersten Schritt trotzdem sichtbar: sonst
              zaehlen die Plus-/Minus-Knoepfe hoch, es klingt, und zu sehen ist nichts.
              Bei 0 und ohne Ziel bleibt die Zeile bewusst leer. */}
          {(challenge.targetCount !== null || challenge.currentCount > 0) && (
            <span className="challenge-source__count" key={ceremonyKey}>
              {challenge.targetCount === null
                ? challenge.currentCount
                : `${String(challenge.currentCount)} / ${String(challenge.targetCount)}`}
            </span>
          )}
          {showTime && (
            <span
              aria-label={done ? `Rest bei Abschluss ${timeText}` : `Restzeit ${timeText}`}
              className="challenge-source__time"
              data-state={done ? "done" : timerState}
            >
              {timerState === "paused" && !done ? "Ⅱ " : ""}{timeText}
            </span>
          )}
        </span>
      </span>
    </li>
  );
};

export const ChallengeLog = ({
  update,
  now,
  clockOffsetMs = 0,
  ceremonyTarget = null,
  ceremonySeq,
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
  clockOffsetMs?: number;
  ceremonyTarget?: ChallengeLogCeremonyTarget | null;
  ceremonySeq?: number | undefined;
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
  const allChallenges = selectVisible(update.challenges, now, { doneOrder: update.settings.doneOrder });
  const globalTimer = update.settings.globalTimer;
  const globalState = globalTimer === null
    ? "idle"
    : deriveTimerState(globalTimer.endsAt, globalTimer.pausedRemainMs, now);
  const globalTimerVisible = globalTimer !== null && globalState !== "idle";
  const capacity = update.settings.maxVisible;
  const pinnedCandidate = allChallenges[0];
  const pinned = pinnedCandidate !== undefined && pinnedCandidate.state !== "done"
    && deriveChallengeTimerState(pinnedCandidate, now) === "running"
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
    "--wc-font-scale": String(update.settings.fontScale),
    "--wc-surface-opacity": String(update.settings.surfaceOpacity / 100),
    "--wc-scroll-visible-rows": String(pageSize),
  } as CSSProperties;
  // Zwei Attribute halten zwei unabhängige Entscheidungen fest: Die größeren
  // Schriftgrade bleiben an der Transparenz als Lesbarkeits-Krücke hängen,
  // Fettung und Schatten folgen dagegen dem eigenen Schrifteffekt-Regler.
  const surfaceMode = update.settings.surfaceOpacity < 50 ? "bare" : "surface";
  const effectiveEmphasis = resolveChallengeTextEmphasis(
    update.settings.textEmphasis,
    update.settings.surfaceOpacity,
  );
  const Root = rootTag ?? "main";

  return (
    <Root
      aria-label={ariaLabel ?? "Challenge-Quelle"}
      className={`challenge-source${update.settings.themeMode === "inherit" ? ` hud-theme--${update.settings.themeId}` : ""}${className === undefined ? "" : ` ${className}`}`}
      data-style={update.settings.styleId}
      data-overflow-mode={effectiveMode}
      data-numbered={update.settings.numbered ? "true" : "false"}
      data-key-visible={update.settings.keyVisible ? "true" : "false"}
      data-surface-mode={surfaceMode}
      data-text-emphasis={effectiveEmphasis}
      data-header-style={update.settings.headerStyle}
      data-font-family={update.settings.fontFamily}
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
            ceremonySeq={ceremonySeq}
            now={now}
            mode={update.settings.globalTimerMode}
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
              ceremonySeq={ceremonySeq}
              ceremonyTargetId={ceremonyTarget?.kind === "challenge" ? ceremonyTarget.id : null}
              challenge={pinned}
              clockOffsetMs={clockOffsetMs}
              numbered={update.settings.numbered}
              keyVisible={update.settings.keyVisible}
              accessibleKey={ariaLabel !== undefined}
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
                  ceremonySeq={ceremonySeq}
                  ceremonyTargetId={ceremonyTarget?.kind === "challenge" ? ceremonyTarget.id : null}
                  challenge={challenge}
                  clockOffsetMs={clockOffsetMs}
                  key={challenge.id}
                  numbered={update.settings.numbered}
                  keyVisible={update.settings.keyVisible}
                  accessibleKey={ariaLabel !== undefined}
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
              ceremonySeq={ceremonySeq}
              ceremonyTargetId={ceremonyTarget?.kind === "challenge" ? ceremonyTarget.id : null}
              challenge={challenge}
              clockOffsetMs={clockOffsetMs}
              key={challenge.id}
              numbered={update.settings.numbered}
              keyVisible={update.settings.keyVisible}
              accessibleKey={ariaLabel !== undefined}
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
              ceremonySeq={ceremonySeq}
              ceremonyTargetId={ceremonyTarget?.kind === "challenge" ? ceremonyTarget.id : null}
              key={challenge.id}
              challenge={challenge}
              clockOffsetMs={clockOffsetMs}
              numbered={update.settings.numbered}
              keyVisible={update.settings.keyVisible}
              accessibleKey={ariaLabel !== undefined}
              number={numbers.get(challenge.id)}
              now={now}
            />
          ))}
          {effectiveMode === "cut" && remaining > 0 && <li className="challenge-source__more">+{remaining} weitere</li>}
        </ul>
      )}
      {update.settings.penaltyText.trim() !== "" && (
        <footer className="challenge-source__penalty">
          {update.settings.penaltyLabel.trim() !== "" && (
            <span className="challenge-source__penalty-label">{update.settings.penaltyLabel}</span>
          )}
          <span className="challenge-source__penalty-text">{update.settings.penaltyText}</span>
        </footer>
      )}
    </Root>
  );
};
