import { useEffect, useMemo, useRef, useState } from "react";

import type { Challenge, ChallengeUpdate, GlobalTimer } from "../shared/contracts/win-challenges";
import { DOCK_SOCKET_PROTOCOL } from "../shared/contracts/protocol";
import { challengeNumbers, formatChallengeStand, selectVisible } from "../modules/win-challenges/domain/visibility";
import { deriveTimerState } from "../modules/win-challenges/domain/timers";
import type { Command } from "../modules/win-challenges/contracts/schemas";
import {
  formatRemaining,
  displayedMsFor,
  remainingFor,
  timerIsCritical,
} from "../modules/win-challenges/ui/timer";
import { parseChallengeMessage, tokenFromLocation } from "../challenges/wire";
import { nextReconnectDelayMs } from "../shared/reconnect";
import "./live.css";

const ERROR_VISIBLE_MS = 3_000;
const DELETED_NOTICE_MS = 1_500;

type OptimisticPatch = Partial<Pick<Challenge, "currentCount" | "state" | "timerEndsAt" | "completedAt" | "hidden">>;

type CommandFailure = {
  code: string;
  message: string;
};

class LiveCommandError extends Error {
  public readonly code: string;

  public constructor(failure: CommandFailure) {
    super(failure.message);
    this.name = "LiveCommandError";
    this.code = failure.code;
  }
}

type DeletedNotice = {
  challenge: Challenge;
  message: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readCommandFailure = async (response: Response): Promise<CommandFailure> => {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && isRecord(body.error)) {
      const code = typeof body.error.code === "string" ? body.error.code : "request_failed";
      const message = typeof body.error.message === "string"
        ? body.error.message
        : `Anfrage fehlgeschlagen (${String(response.status)}).`;
      return { code, message };
    }
  } catch {
    // Der öffentliche Fallback darf keine rohen Antwortdaten anzeigen.
  }
  return {
    code: "request_failed",
    message: `Anfrage fehlgeschlagen (${String(response.status)}).`,
  };
};

const sendCommand = async (token: string, command: Command): Promise<void> => {
  const response = await fetch("/api/challenges/commands", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new LiveCommandError(await readCommandFailure(response));
};

const commandId = (): string => crypto.randomUUID();

const challengeCommand = (
  type: "complete" | "reopen" | "startTimer" | "stopTimer",
  challengeId: string,
): Command => ({
  commandId: commandId(),
  scope: "challenge",
  type,
  challengeId,
});

const incrementCommand = (challengeId: string, delta: number): Command => ({
  commandId: commandId(),
  scope: "challenge",
  type: "increment",
  challengeId,
  delta,
});

const globalCommand = (type: "startGlobalTimer" | "pauseGlobalTimer"): Command => ({
  commandId: commandId(),
  scope: "global",
  type,
});

const optimisticPatchFor = (
  update: ChallengeUpdate,
  command: Command,
): OptimisticPatch | null => {
  if (command.scope === "global") return null;
  const challenge = update.challenges.find((candidate) => candidate.id === command.challengeId);
  if (challenge === undefined) return null;
  if (command.type === "increment") {
    if (challenge.state === "done") return null;
    const maximum = challenge.targetCount ?? 999;
    const currentCount = Math.max(0, Math.min(maximum, challenge.currentCount + command.delta));
    if (currentCount === challenge.currentCount) return null;
    return challenge.targetCount !== null && currentCount === challenge.targetCount
      ? { currentCount, state: "done", timerEndsAt: null, completedAt: new Date().toISOString(), hidden: false }
      : { currentCount };
  }
  if (command.type === "complete") {
    if (challenge.state === "done") return null;
    return { state: "done", timerEndsAt: null, completedAt: new Date().toISOString(), hidden: false };
  }
  if (command.type === "reopen") {
    if (challenge.state !== "done") return null;
    return {
      state: "pending",
      timerEndsAt: null,
      completedAt: null,
    };
  }
  if (command.type === "startTimer") {
    if (challenge.state === "done" || challenge.timerTotalMs === null) return null;
    return {
      state: "active",
      timerEndsAt: new Date(Date.now() + challenge.timerTotalMs).toISOString(),
    };
  }
  return challenge.state === "active" ? { state: "pending", timerEndsAt: null } : null;
};

const mergeChallenge = (challenge: Challenge, patch: OptimisticPatch | undefined): Challenge =>
  patch === undefined ? challenge : { ...challenge, ...patch };

const withoutKey = function <T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
};

const challengeErrorMessage = (error: unknown): string => {
  if (error instanceof LiveCommandError) {
    return error.code === "not_found" ? "Challenge wurde gerade gelöscht." : error.message;
  }
  return "Die Änderung konnte nicht gespeichert werden.";
};

const ChallengeRow = ({
  challenge,
  pending,
  error,
  pinned,
  deleted,
  compact,
  now,
  number,
  numbered,
  onCommand,
}: {
  challenge: Challenge;
  pending: boolean;
  error: string | null;
  pinned: boolean;
  deleted: boolean;
  compact: boolean;
  now: number;
  number: number | undefined;
  numbered: boolean;
  onCommand: (command: Command, challengeId: string) => void;
}) => {
  const done = challenge.state === "done";
  const hasTimer = challenge.timerTotalMs !== null;
  const timerState = hasTimer && challenge.timerEndsAt !== null
    ? deriveTimerState(challenge.timerEndsAt, null, now)
    : "idle";
  const timerRunning = timerState === "running";
  return (
    <article
      className={`live-page__challenge-row${pinned ? " live-page__challenge-row--pinned" : ""}${done ? " live-page__challenge-row--done" : ""}${pending ? " live-page__challenge-row--pending" : ""}`}
      data-challenge-id={challenge.id}
      data-state={challenge.state}
    >
      <div className="live-page__challenge-main">
        <span aria-hidden="true" className="live-page__challenge-mark">{done ? "✓" : "▸"}</span>
        {numbered && number !== undefined && <span aria-hidden="true" className="live-page__challenge-number">{number}</span>}
        <span className="live-page__challenge-title">{challenge.title}</span>
        {challenge.hidden && <span className="live-page__challenge-hidden-badge">ausgeblendet</span>}
        <span className="live-page__challenge-count">
          {challenge.targetCount === null
            ? String(challenge.currentCount)
            : `${String(challenge.currentCount)} / ${String(challenge.targetCount)}`}
        </span>
      </div>
      {!deleted && !compact && (
        <div className="live-page__challenge-actions" aria-label={`${challenge.title} bedienen`}>
          {!done && (
            <>
              <button
                aria-label={`${challenge.title} um 1 verringern`}
                className="live-control live-control--count"
                disabled={pending || challenge.currentCount === 0}
                onClick={() => onCommand(incrementCommand(challenge.id, -1), challenge.id)}
                type="button"
              >−</button>
              <button
                aria-label={`${challenge.title} um 1 erhöhen`}
                className="live-control live-control--count"
                disabled={pending}
                onClick={() => onCommand(incrementCommand(challenge.id, 1), challenge.id)}
                type="button"
              >+</button>
              <button
                aria-label={`${challenge.title} abhaken`}
                className="live-control"
                disabled={pending}
                onClick={() => onCommand(challengeCommand("complete", challenge.id), challenge.id)}
                type="button"
              >✓</button>
            </>
          )}
          {done && (
            <button
              aria-label={`${challenge.title} Rückgängig`}
              className="live-control"
              disabled={pending}
              onClick={() => onCommand(challengeCommand("reopen", challenge.id), challenge.id)}
              type="button"
            >Rückgängig</button>
          )}
          {hasTimer && !done && (
            <button
              aria-label={`${challenge.title} ${timerRunning ? "Timer stoppen" : "Timer starten"}`}
              className="live-control"
              disabled={pending}
              onClick={() => onCommand(challengeCommand(timerRunning ? "stopTimer" : "startTimer", challenge.id), challenge.id)}
              type="button"
            >{timerRunning ? "Timer stoppen" : "Timer starten"}</button>
          )}
        </div>
      )}
      {pending && <span className="live-page__pending-label">wird übernommen …</span>}
      {error !== null && <p className="live-page__row-error" role="alert">{error}</p>}
    </article>
  );
};

const GlobalTimerControl = ({
  timer,
  mode,
  now,
  pending,
  error,
  onCommand,
}: {
  timer: GlobalTimer | null;
  mode: ChallengeUpdate["settings"]["globalTimerMode"];
  now: number;
  pending: boolean;
  error: string | null;
  onCommand: (command: Command) => void;
}) => {
  const state = timer === null ? "idle" : deriveTimerState(timer.endsAt, timer.pausedRemainMs, now);
  const remainingMs = timer === null ? 0 : remainingFor(timer.endsAt, timer.pausedRemainMs, state, now);
  const critical = timer !== null && timerIsCritical(state, remainingMs, mode);
  const displayedMs = timer === null || state === "idle" ? 0 : displayedMsFor(mode, timer.totalMs, remainingMs);
  const label = timer === null
    ? "Globaler Timer ist nicht eingerichtet"
    : state === "running"
      ? "Globalen Timer pausieren"
      : "Globalen Timer starten";
  return (
    <section className="live-page__global" aria-label="Globaler Timer">
      <div
        className={`live-page__global-display${critical ? " live-page__global-display--critical" : ""}`}
        aria-label={`Globaler Timer: ${formatRemaining(displayedMs)}${state === "paused" ? ", pausiert" : state === "expired" && mode === "down" ? ", abgelaufen" : ""}${mode === "up" ? ", hochzählend" : ""}`}
        data-critical={critical ? "true" : "false"}
        data-state={state}
      >
        <span className="live-page__global-label">Global</span>
        <span aria-hidden="true">{state === "paused" ? "Ⅱ" : critical ? "!" : mode === "up" ? "▴" : "▸"}</span>
        <strong>{formatRemaining(displayedMs)}</strong>
        {state === "paused" && <span>pausiert</span>}
        {state === "expired" && mode === "down" && <span>abgelaufen</span>}
      </div>
      <button
        className="live-control live-page__global-toggle"
        disabled={timer === null || pending}
        onClick={() => onCommand(globalCommand(state === "running" ? "pauseGlobalTimer" : "startGlobalTimer"))}
        type="button"
      >{label}</button>
      {error !== null && <p className="live-page__global-error" role="alert">{error}</p>}
    </section>
  );
};

const useCompactViewport = (): boolean => {
  const [compact, setCompact] = useState(() => window.innerWidth < 280);

  useEffect(() => {
    const update = () => setCompact(window.innerWidth < 280);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return compact;
};

export const LiveApp = () => {
  const token = useMemo(() => tokenFromLocation(), []);
  const compact = useCompactViewport();
  const [update, setUpdate] = useState<ChallengeUpdate | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [connection, setConnection] = useState<"loading" | "connected" | "offline" | "invalid" | "revoked">(
    token === null ? "invalid" : "loading",
  );
  const [optimistic, setOptimistic] = useState<Record<string, OptimisticPatch>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [globalPending, setGlobalPending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [deletedNotice, setDeletedNotice] = useState<DeletedNotice | null>(null);
  const knownChallengesRef = useRef(new Map<string, Challenge>());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (token === null) return;
    let disposed = false;
    let revoked = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    let retry = 0;

    const connect = () => {
      if (disposed || revoked) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/dock`, [DOCK_SOCKET_PROTOCOL, token]);
      socket.addEventListener("open", () => {
        retry = 0;
        setConnection("connected");
      });
      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") return;
        let input: unknown;
        try {
          input = JSON.parse(message.data) as unknown;
        } catch {
          return;
        }
        const parsed = parseChallengeMessage(input);
        if (parsed === null) return;
        if (!("eventSeq" in parsed)) {
          revoked = true;
          setConnection("revoked");
          setUpdate(null);
          socket?.close();
          return;
        }
        parsed.challenges.forEach((challenge) => knownChallengesRef.current.set(challenge.id, challenge));
        setUpdate(parsed);
        // Der Socket ist die Wahrheit: lokale Sprünge und Schwebezustände enden hier.
        setOptimistic({});
        setPending({});
        setGlobalPending(false);
      });
      socket.addEventListener("close", () => {
        if (disposed || revoked) return;
        setConnection("offline");
        const delay = nextReconnectDelayMs(retry);
        retry += 1;
        retryTimer = window.setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [token]);

  const runCommand = (command: Command, challengeId?: string): void => {
    if (token === null) return;
    if (challengeId !== undefined) {
      setPending((current) => ({ ...current, [challengeId]: true }));
      if (update !== null) {
        const patch = optimisticPatchFor(update, command);
        if (patch !== null) setOptimistic((current) => ({ ...current, [challengeId]: patch }));
      }
    } else {
      setGlobalPending(true);
    }
    void sendCommand(token, command).catch((error: unknown) => {
      if (challengeId !== undefined) {
        setOptimistic((current) => withoutKey(current, challengeId));
        setPending((current) => withoutKey(current, challengeId));
        const message = challengeErrorMessage(error);
        if (error instanceof LiveCommandError && error.code === "not_found") {
          const challenge = knownChallengesRef.current.get(challengeId);
          if (challenge !== undefined) {
            setDeletedNotice({ challenge, message });
            window.setTimeout(() => {
              setDeletedNotice((current) => current?.challenge.id === challengeId ? null : current);
            }, DELETED_NOTICE_MS);
          }
        } else {
          setErrors((current) => ({ ...current, [challengeId]: message }));
          window.setTimeout(() => setErrors((current) => withoutKey(current, challengeId)), ERROR_VISIBLE_MS);
        }
      } else {
        setGlobalPending(false);
        setGlobalError(challengeErrorMessage(error));
        window.setTimeout(() => setGlobalError(null), ERROR_VISIBLE_MS);
      }
    });
  };

  if (token === null) {
    return (
      <main aria-label="Live-Bedienseite" className="live-page live-page--message" data-status="invalid">
        <p className="live-page__eyebrow">Live / Challenges</p>
        <h1>Dock-Token fehlt</h1>
        <p>Öffne diese Seite mit dem Dock-Token aus der Einrichtungsseite.</p>
      </main>
    );
  }

  if (update === null) {
    return (
      <main aria-label="Live-Bedienseite" className="live-page live-page--loading" data-status={connection}>
        <header className="live-page__header">
          <p className="live-page__eyebrow">Live / Challenges</p>
          <h1>Live-Steuerung</h1>
        </header>
        <div className="live-page__skeleton" aria-label="Challenges werden geladen">
          <span /><span /><span />
        </div>
        {connection === "revoked" && <p role="alert">Der Dock-Token wurde widerrufen.</p>}
      </main>
    );
  }

  const patchedChallenges = update.challenges.map((challenge) => mergeChallenge(challenge, optimistic[challenge.id]));
  const selectedChallenges = selectVisible(patchedChallenges, now, { doneOrder: update.settings.doneOrder, includeHidden: true });
  const numbers = challengeNumbers(patchedChallenges);
  const rows = selectedChallenges;
  if (deletedNotice !== null && !rows.some((challenge) => challenge.id === deletedNotice.challenge.id)) {
    rows.push(deletedNotice.challenge);
  }
  const pinnedId = selectedChallenges[0]?.id ?? null;
  const visibleRows = compact
    ? pinnedId === null ? [] : rows.filter((challenge) => challenge.id === pinnedId)
    : rows;
  const hasRows = visibleRows.length > 0;
  const hasOpen = patchedChallenges.some((challenge) => challenge.state !== "done");

  return (
    <main aria-label="Live-Bedienseite" className="live-page" data-status={connection}>
      {!compact && <header className="live-page__header">
        <div>
          <p className="live-page__eyebrow">Live / Challenges</p>
          <h1>Live-Steuerung</h1>
        </div>
        <div className="live-page__header-meta">
          <span aria-label="Challenge-Stand" className="live-page__stand">{formatChallengeStand(patchedChallenges)}</span>
          <span className="live-page__connection">{connection === "connected" ? "verbunden" : "offline"}</span>
        </div>
      </header>}
      {!compact && <GlobalTimerControl
          error={globalError}
          now={now}
          mode={update.settings.globalTimerMode}
          onCommand={(command) => runCommand(command)}
          pending={globalPending}
          timer={update.settings.globalTimer}
        />}
      {hasRows ? (
        <section aria-label="Challenges" className="live-page__challenge-list">
          {visibleRows.map((challenge) => (
            <ChallengeRow
              compact={compact}
              challenge={challenge}
              deleted={deletedNotice?.challenge.id === challenge.id && !update.challenges.some((candidate) => candidate.id === challenge.id)}
              error={errors[challenge.id] ?? (deletedNotice?.challenge.id === challenge.id ? deletedNotice.message : null)}
              key={challenge.id}
              numbered={update.settings.numbered}
              number={numbers.get(challenge.id)}
              onCommand={(command, challengeId) => runCommand(command, challengeId)}
              pending={pending[challenge.id] === true}
              pinned={challenge.id === pinnedId}
              now={now}
            />
          ))}
        </section>
      ) : !compact ? (
        <section className="live-page__empty" aria-label="Keine Challenges">
          <p>{hasOpen ? "Keine sichtbare Challenge." : "Keine offenen Challenges."}</p>
          <a href="/admin/challenges">Im Board eine Challenge anlegen</a>
        </section>
      ) : null}
    </main>
  );
};
