import { useEffect, useRef, useState } from "react";

import type {
  Challenge,
  ChallengeUpdate,
  GlobalTimer,
} from "../shared/contracts/win-challenges";
import { OVERLAY_SOCKET_PROTOCOL } from "../shared/contracts/protocol";
import { selectVisible } from "../modules/win-challenges/domain/visibility";
import { deriveTimerState, type TimerState } from "../modules/win-challenges/domain/timers";
import "./challenge-source.css";
import {
  accountForChallengeUpdate,
  parseChallengeMessage,
} from "./wire";

const RETRY_BASE_MS = 750;

const formatRemaining = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${String(hours)}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${String(minutes)}:${String(rest).padStart(2, "0")}`;
};

const remainingFor = (
  endsAt: string | null,
  pausedRemainMs: number | null,
  state: TimerState,
  now: number,
): number => {
  if (state === "running" && endsAt !== null) return Math.max(0, Date.parse(endsAt) - now);
  if (state === "paused" && pausedRemainMs !== null) return pausedRemainMs;
  return 0;
};

const timerClass = (state: TimerState, remainingMs: number): string =>
  state === "paused"
    ? "challenge-source__timer--paused"
    : remainingMs > 0 && remainingMs < 60_000
      ? "challenge-source__timer--critical"
      : "";

const GlobalTimerRow = ({ timer, now }: { timer: GlobalTimer; now: number }) => {
  const state = deriveTimerState(timer.endsAt, timer.pausedRemainMs, now);
  const remainingMs = remainingFor(timer.endsAt, timer.pausedRemainMs, state, now);
  return (
    <div
      aria-label={`Globaler Timer: ${formatRemaining(remainingMs)}`}
      className={`challenge-source__timer ${timerClass(state, remainingMs)}`}
      data-state={state}
    >
      <span aria-hidden="true">{state === "paused" ? "Ⅱ" : "▸"}</span>
      <span>{formatRemaining(remainingMs)}</span>
      {state === "paused" && <span className="challenge-source__timer-label">pausiert</span>}
    </div>
  );
};

const ChallengeRow = ({ challenge, now }: { challenge: Challenge; now: number }) => {
  const done = challenge.state === "done";
  const timerState = challenge.timerEndsAt === null
    ? "idle"
    : deriveTimerState(challenge.timerEndsAt, null, now);
  const remainingMs = remainingFor(challenge.timerEndsAt, null, timerState, now);
  return (
    <div
      className={`challenge-source__row${done ? " challenge-source__row--done" : ""}`}
      data-challenge-id={challenge.id}
      data-state={challenge.state}
    >
      <span aria-hidden="true" className="challenge-source__mark">{done ? "✓" : "▸"}</span>
      <span className="challenge-source__name">{challenge.title}</span>
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

const ChallengeLog = ({ update, now }: { update: ChallengeUpdate; now: number }) => {
  if (update.settings.styleId !== "plain-list") return null;
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
  if (challenges.length === 0 && (globalTimer === null || globalState === "idle")) return null;

  const completed = update.challenges.filter((challenge) => challenge.state === "done").length;
  return (
    <main
      aria-label="Challenge-Quelle"
      className="challenge-source"
      data-style={update.settings.styleId}
      data-surface-mode={update.settings.surfaceMode}
      data-theme-mode={update.settings.themeMode}
    >
      <header className="challenge-source__header">
        <span className="challenge-source__title">{update.settings.headerTitle}</span>
        <span className="challenge-source__stand">{completed} / {update.challenges.length}</span>
      </header>
      {globalTimer !== null && <GlobalTimerRow now={now} timer={globalTimer} />}
      <section aria-label="Challenges" className="challenge-source__rows">
        {challenges.map((challenge) => <ChallengeRow key={challenge.id} challenge={challenge} now={now} />)}
        {remaining > 0 && <p className="challenge-source__more">+{remaining} weitere</p>}
      </section>
    </main>
  );
};

export const ChallengeSourceApp = () => {
  const [update, setUpdate] = useState<ChallengeUpdate | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lastSeenRef = useRef(-1);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = params.get("token");
    if (token === null || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;

    let disposed = false;
    let revoked = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    let retry = 0;

    const connect = () => {
      if (disposed || revoked) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/challenge`, [
        OVERLAY_SOCKET_PROTOCOL,
        token,
      ]);
      socket.addEventListener("open", () => {
        retry = 0;
      });
      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") return;
        let input: unknown;
        try {
          input = JSON.parse(message.data) as unknown;
        } catch {
          setUpdate(null);
          return;
        }
        const parsed = parseChallengeMessage(input);
        if (parsed === null) {
          // Ein Parse-Fehler darf das HUD vor Zuschauern niemals neu laden.
          setUpdate(null);
          return;
        }
        if (!("eventSeq" in parsed)) {
          revoked = true;
          setUpdate(null);
          socket?.close();
          return;
        }
        const ceremony = accountForChallengeUpdate(parsed, lastSeenRef.current);
        lastSeenRef.current = ceremony.lastSeen;
        // Schritt 13 hängt die Zeremonie an `ceremony.shouldFire` ein. Die
        // lastSeen-Buchführung läuft schon jetzt, damit dort nur noch der
        // Effekt fehlt und nicht die Regel, wann er feuern darf.
        setUpdate(parsed);
      });
      socket.addEventListener("close", () => {
        if (disposed || revoked) return;
        setUpdate(null);
        const delay = Math.min(30_000, RETRY_BASE_MS * 2 ** retry);
        retry += 1;
        retryTimer = window.setTimeout(connect, delay + Math.floor(Math.random() * 400));
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  return update === null ? null : <ChallengeLog now={now} update={update} />;
};
