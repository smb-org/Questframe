import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  GripVertical,
  Info,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ChallengeUpdate } from "../../../shared/contracts/win-challenges";
import {
  boardSaveRequestSchema,
  challengeBoardSnapshotSchema,
  type BoardSaveRequest,
  type BoardSaveResponse,
  type ChallengeBoardSnapshot,
  type ChallengeDefinition,
  type Challenge,
} from "../contracts/schemas";

export type ChallengeBoardSubscription = {
  onChallengeUpdate: (update: ChallengeUpdate) => void;
  onOnlineChange?: (online: boolean) => void;
};

export type ChallengeBoardApi = {
  load: () => Promise<ChallengeBoardSnapshot>;
  save: (request: BoardSaveRequest) => Promise<BoardSaveResponse>;
  subscribe?: (callbacks: ChallengeBoardSubscription) => () => void;
};

type ChallengeDraft = {
  key: string;
  identity: { id: string } | { clientId: string };
  title: string;
  description: string | null;
  targetCount: number | null;
  timerTotalMs: number | null;
  sortOrder: number;
  hidden: boolean;
  currentCount: number;
  state: Challenge["state"];
  timerEndsAt: string | null;
};

type MergeNotice = {
  key: string;
  kind: "retained-count" | "clamped-count" | "timer-removed" | "timer-changed";
  message: string;
};

const snapshotFromUpdate = (update: ChallengeUpdate): ChallengeBoardSnapshot => {
  const { themeId: _themeId, ...settings } = update.settings;
  void _themeId;
  return {
    eventSeq: update.eventSeq,
    boardRevision: update.boardRevision,
    settingsRevision: update.settingsRevision,
    settings,
    challenges: update.challenges,
  };
};

const draftFromChallenge = (challenge: Challenge): ChallengeDraft => ({
  key: challenge.id,
  identity: { id: challenge.id },
  title: challenge.title,
  description: challenge.description,
  targetCount: challenge.targetCount,
  timerTotalMs: challenge.timerTotalMs,
  sortOrder: challenge.sortOrder,
  hidden: challenge.hidden,
  currentCount: challenge.currentCount,
  state: challenge.state,
  timerEndsAt: challenge.timerEndsAt,
});

const draftsFromSnapshot = (snapshot: ChallengeBoardSnapshot): ChallengeDraft[] =>
  [...snapshot.challenges]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map(draftFromChallenge);

const definitionFromDraft = (draft: ChallengeDraft): ChallengeDefinition => {
  const fields = {
    title: draft.title,
    description: draft.description,
    targetCount: draft.targetCount,
    timerTotalMs: draft.timerTotalMs,
    sortOrder: draft.sortOrder,
    hidden: draft.hidden,
  } as const;
  return "id" in draft.identity
    ? { id: draft.identity.id, ...fields }
    : { clientId: draft.identity.clientId, ...fields };
};

const definitionsFromDrafts = (drafts: readonly ChallengeDraft[]): BoardSaveRequest["challenges"] =>
  drafts.map(definitionFromDraft);

const sameDefinitions = (
  left: readonly ChallengeDraft[],
  right: readonly ChallengeDraft[],
): boolean => JSON.stringify(definitionsFromDrafts(left)) === JSON.stringify(definitionsFromDrafts(right));

const clientIdForNewChallenge = (): string => `client-${crypto.randomUUID()}`;

const snapshotFromUnknown = (value: unknown): ChallengeBoardSnapshot | null => {
  const parsed = challengeBoardSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const noticesFor = (
  drafts: readonly ChallengeDraft[],
  saved: ChallengeBoardSnapshot,
): MergeNotice[] => {
  const savedById = new Map(saved.challenges.map((challenge) => [challenge.id, challenge]));
  const notices: MergeNotice[] = [];
  for (const draft of drafts) {
    const savedChallenge = "id" in draft.identity ? savedById.get(draft.identity.id) : undefined;
    if (draft.targetCount === null && draft.currentCount > 0) {
      notices.push({
        key: `${draft.key}-retained-count`,
        kind: "retained-count",
        message: `Gespeicherter Stand bleibt erhalten: ${String(draft.currentCount)}. Er erscheint wieder, sobald ein Ziel gesetzt wird.`,
      });
    }
    if (draft.targetCount !== null && draft.currentCount > draft.targetCount) {
      notices.push({
        key: `${draft.key}-clamped-count`,
        kind: "clamped-count",
        message: `Beim Speichern wird der Stand auf ${String(draft.targetCount)} geklemmt (aktuell ${String(draft.currentCount)}).`,
      });
    }
    if (savedChallenge?.state === "active" && savedChallenge.timerTotalMs !== null && draft.timerTotalMs === null) {
      notices.push({
        key: `${draft.key}-timer-removed`,
        kind: "timer-removed",
        message: "Der laufende Timer endet beim Speichern; die Challenge fällt auf „pending“.",
      });
    }
    if (
      savedChallenge?.state === "active" &&
      savedChallenge.timerTotalMs !== null &&
      draft.timerTotalMs !== null &&
      savedChallenge.timerTotalMs !== draft.timerTotalMs
    ) {
      notices.push({
        key: `${draft.key}-timer-changed`,
        kind: "timer-changed",
        message: "Der laufende Timer behält seinen Endzeitpunkt. Die neue Dauer gilt ab dem nächsten Start.",
      });
    }
  }
  return notices;
};

const secondsFromTimer = (timerTotalMs: number | null): string =>
  timerTotalMs === null ? "" : String(Math.round(timerTotalMs / 1_000));

const parseTimerSeconds = (value: string): number | null => {
  if (value.trim() === "") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return Math.round(seconds * 1_000);
};

const applyCreatedIds = (
  drafts: readonly ChallengeDraft[],
  response: BoardSaveResponse,
): ChallengeDraft[] => {
  const savedById = new Map(response.snapshot.challenges.map((challenge) => [challenge.id, challenge]));
  return draftsFromSnapshot(response.snapshot).map((savedDraft) => {
    const savedId = "id" in savedDraft.identity ? savedDraft.identity.id : null;
    if (savedId === null) return savedDraft;
    const submitted = drafts.find((draft) => {
      if ("id" in draft.identity) return draft.identity.id === savedId;
      return response.createdIds[draft.identity.clientId] === savedId;
    });
    if (submitted === undefined) return savedDraft;
    const savedChallenge = savedById.get(savedId);
    return savedChallenge === undefined
      ? savedDraft
      : { ...savedDraft, key: submitted.key, identity: { id: savedChallenge.id } };
  });
};

const reorder = (drafts: readonly ChallengeDraft[], from: number, to: number): ChallengeDraft[] => {
  if (from < 0 || to < 0 || from >= drafts.length || to >= drafts.length) return [...drafts];
  const next = [...drafts];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(to, 0, moved);
  return next.map((draft, sortOrder) => ({ ...draft, sortOrder }));
};

const defaultDraft = (sortOrder: number): ChallengeDraft => ({
  key: clientIdForNewChallenge(),
  identity: { clientId: clientIdForNewChallenge() },
  title: "Neue Challenge",
  description: null,
  targetCount: null,
  timerTotalMs: null,
  sortOrder,
  hidden: false,
  currentCount: 0,
  state: "pending",
  timerEndsAt: null,
});

const ChallengeRow = ({
  draft,
  index,
  total,
  disabled,
  onChange,
  onDelete,
  onMove,
  onDragStart,
  onDrop,
}: {
  draft: ChallengeDraft;
  index: number;
  total: number;
  disabled: boolean;
  onChange: (patch: Partial<ChallengeDraft>) => void;
  onDelete: () => void;
  onMove: (to: number) => void;
  onDragStart: () => void;
  onDrop: () => void;
}) => {
  const hasTarget = draft.targetCount !== null;
  const hasTimer = draft.timerTotalMs !== null;
  return (
    <article
      className="challenge-board-row"
      draggable={!disabled}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
    >
      <div className="challenge-row-order">
        <button
          aria-label={`${draft.title} nach oben verschieben`}
          className="icon-button"
          disabled={disabled || index === 0}
          onClick={() => onMove(index - 1)}
          type="button"
        >
          <ArrowUp size={16} />
        </button>
        <button
          aria-label={`${draft.title} nach unten verschieben`}
          className="icon-button"
          disabled={disabled || index === total - 1}
          onClick={() => onMove(index + 1)}
          type="button"
        >
          <ArrowDown size={16} />
        </button>
        <button
          aria-label={`${draft.title} sortieren`}
          className="challenge-drag-handle"
          disabled={disabled}
          draggable={!disabled}
          onDragStart={onDragStart}
          title="Zum Sortieren ziehen"
          type="button"
        >
          <GripVertical size={18} />
        </button>
      </div>
      <div className="challenge-row-fields">
        <label className="challenge-field challenge-field--title">
          <span>Titel</span>
          <input
            disabled={disabled}
            maxLength={80}
            value={draft.title}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </label>
        <label className="challenge-field challenge-field--description">
          <span>Beschreibung</span>
          <textarea
            disabled={disabled}
            maxLength={160}
            rows={2}
            value={draft.description ?? ""}
            onChange={(event) => onChange({ description: event.target.value === "" ? null : event.target.value })}
          />
        </label>
        <label className="challenge-field">
          <span>Zielwert</span>
          <span className="challenge-toggle-field">
            <input
              aria-label={`${draft.title} mit Zielwert`}
              checked={hasTarget}
              disabled={disabled}
              onChange={(event) => onChange({ targetCount: event.target.checked ? Math.max(1, draft.currentCount) : null })}
              type="checkbox"
            />
            <input
              aria-label={`${draft.title} Zielwert`}
              disabled={disabled || !hasTarget}
              max={999}
              min={1}
              type="number"
              value={hasTarget ? String(draft.targetCount) : ""}
              onChange={(event) => onChange({ targetCount: event.target.value === "" ? null : Number(event.target.value) })}
            />
          </span>
        </label>
        <label className="challenge-field">
          <span>Timer (Sekunden)</span>
          <span className="challenge-toggle-field">
            <input
              aria-label={`${draft.title} mit Timer`}
              checked={hasTimer}
              disabled={disabled}
              onChange={(event) => onChange({ timerTotalMs: event.target.checked ? 60_000 : null })}
              type="checkbox"
            />
            <input
              aria-label={`${draft.title} Timerdauer in Sekunden`}
              disabled={disabled || !hasTimer}
              max={21_600}
              min={10}
              type="number"
              value={secondsFromTimer(draft.timerTotalMs)}
              onChange={(event) => onChange({ timerTotalMs: parseTimerSeconds(event.target.value) })}
            />
          </span>
        </label>
      </div>
      <div className="challenge-row-runtime" aria-label={`${draft.title} Laufzeitstand`}>
        <span className={`challenge-state challenge-state--${draft.state}`}>
          <i aria-hidden="true" /> {draft.state === "active" ? "läuft" : draft.state === "done" ? "erledigt" : "offen"}
        </span>
        <button
          aria-checked={draft.hidden}
          aria-label={`${draft.title} ${draft.hidden ? "einblenden" : "ausblenden"}`}
          className={`challenge-hidden-toggle ${draft.hidden ? "is-on" : "is-off"}`}
          disabled={disabled || draft.state === "done"}
          onClick={() => onChange({ hidden: !draft.hidden })}
          role="switch"
          title={draft.state === "done" ? "Erledigte Challenges können nicht ausgeblendet werden." : "Challenge im OBS-Overlay ein- oder ausblenden."}
          type="button"
        >
          <span>{draft.hidden ? "Ausgeblendet" : "Sichtbar"}</span>
          <i aria-hidden="true" />
        </button>
        <strong>
          {draft.targetCount === null
            ? `Stand ${String(draft.currentCount)}`
            : `${String(draft.currentCount)} / ${String(draft.targetCount)}`}
        </strong>
        {draft.state === "done" && <small>Erledigte Challenges bleiben sichtbar.</small>}
        {draft.targetCount === null && draft.currentCount > 0 && (
          <small>Stand bleibt erhalten</small>
        )}
      </div>
      <button
        aria-label={`${draft.title} löschen`}
        className="icon-button challenge-delete"
        disabled={disabled}
        onClick={onDelete}
        type="button"
      >
        <Trash2 size={17} />
      </button>
    </article>
  );
};

export const ChallengeBoard = ({
  api,
  onOnlineChange,
}: {
  api: ChallengeBoardApi;
  onOnlineChange?: (online: boolean) => void;
}) => {
  const [snapshot, setSnapshot] = useState<ChallengeBoardSnapshot | null>(null);
  const [drafts, setDrafts] = useState<ChallengeDraft[]>([]);
  const [conflict, setConflict] = useState<ChallengeBoardSnapshot | null>(null);
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const snapshotRef = useRef<ChallengeBoardSnapshot | null>(null);
  const draftsRef = useRef<ChallengeDraft[]>([]);

  useEffect(() => {
    snapshotRef.current = snapshot;
    draftsRef.current = drafts;
  }, [drafts, snapshot]);

  const dirty = useMemo(
    () => snapshot !== null && !sameDefinitions(drafts, draftsFromSnapshot(snapshot)),
    [drafts, snapshot],
  );
  const notices = useMemo(
    () => (snapshot === null ? [] : noticesFor(drafts, snapshot)),
    [drafts, snapshot],
  );

  const applySnapshot = useCallback((next: ChallengeBoardSnapshot, nextMessage = "") => {
    setSnapshot(next);
    setDrafts(draftsFromSnapshot(next));
    setConflict(null);
    setMessage(nextMessage);
    setError("");
  }, []);

  useEffect(() => {
    let disposed = false;
    void api
      .load()
      .then((loaded) => {
        if (disposed) return;
        applySnapshot(loaded);
      })
      .catch(() => {
        if (!disposed) setError("Das Challenge-Board konnte nicht geladen werden.");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [api, applySnapshot]);

  useEffect(() => {
    if (api.subscribe === undefined) return;
    return api.subscribe({
      onOnlineChange: (nextOnline) => {
        setOnline(nextOnline);
        onOnlineChange?.(nextOnline);
      },
      onChallengeUpdate: (update) => {
        const incoming = snapshotFromUpdate(update);
        const current = snapshotRef.current;
        if (current !== null && incoming.boardRevision <= current.boardRevision) return;
        const currentDrafts = draftsRef.current;
        const isDirty = current !== null && !sameDefinitions(currentDrafts, draftsFromSnapshot(current));
        setSnapshot(incoming);
        if (isDirty) {
          setConflict(incoming);
        } else {
          setDrafts(draftsFromSnapshot(incoming));
          setConflict(null);
        }
      },
    });
  }, [api, onOnlineChange]);

  const updateDraft = (key: string, patch: Partial<ChallengeDraft>) => {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
    setMessage("");
    setError("");
  };

  const moveDraft = (key: string, to: number) => {
    setDrafts((current) => {
      const from = current.findIndex((draft) => draft.key === key);
      return reorder(current, from, to);
    });
    setMessage("");
  };

  const save = async (replaceForeignBoard = false) => {
    if (snapshot === null || !dirty || saving || !online) return;
    if (conflict !== null && !replaceForeignBoard) {
      setError("Jemand anderes hat das Board gespeichert. Bitte eine Konfliktaktion wählen.");
      return;
    }
    const baseBoardRevision = replaceForeignBoard && conflict !== null
      ? conflict.boardRevision
      : snapshot.boardRevision;
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const request = boardSaveRequestSchema.parse({
        baseBoardRevision,
        challenges: definitionsFromDrafts(drafts),
      });
      const response = await api.save(request);
      const resolvedDrafts = applyCreatedIds(drafts, response);
      setSnapshot(response.snapshot);
      setDrafts(resolvedDrafts);
      setConflict(null);
      setMessage(`Board gespeichert · Revision ${String(response.snapshot.boardRevision)}.`);
    } catch (caught) {
      const candidate = typeof caught === "object" && caught !== null
        ? caught as { code?: unknown; currentSnapshot?: unknown }
        : {};
      const currentSnapshot = candidate.code === "revision_conflict"
        ? snapshotFromUnknown(candidate.currentSnapshot)
        : null;
      if (currentSnapshot !== null) {
        setConflict(currentSnapshot);
        setError("Jemand anderes hat gespeichert. Der aktuelle Serverstand ist unten sichtbar; dein Entwurf bleibt erhalten.");
      } else {
        setError(caught instanceof Error ? caught.message : "Board konnte nicht gespeichert werden.");
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <section aria-busy="true" className="challenge-board-shell"><p className="challenge-board-loading">Challenge-Board wird geladen …</p></section>;
  }

  if (snapshot === null) {
    return (
      <section className="challenge-board-shell" role="alert">
        <div className="challenge-board-empty"><AlertTriangle size={22} /><strong>{error || "Board nicht verfügbar"}</strong><button className="button button--primary" onClick={() => window.location.reload()} type="button">Erneut laden</button></div>
      </section>
    );
  }

  return (
    <section className="challenge-board-shell" aria-busy={saving}>
      <header className="challenge-board-heading">
        <div>
          <span className="eyebrow">Win-Challenges</span>
          <h1>Board</h1>
          <p>Definiere Reihenfolge, Texte, Zielwerte und Timer. Der aktuelle Laufzeitstand bleibt dabei geschützt.</p>
        </div>
        <div className="challenge-board-meta">
          <span className="challenge-revision">Board-Revision {snapshot.boardRevision}</span>
          <span className={online ? "connection-state is-online" : "connection-state is-offline"}>
            <i aria-hidden="true" /> {online ? "Live verbunden" : "Offline"}
          </span>
        </div>
      </header>

      {conflict !== null && (
        <section className="challenge-board-conflict" role="alert">
          <div className="challenge-notice-icon"><AlertTriangle size={19} /></div>
          <div>
            <strong>Jemand anderes hat das Board gespeichert.</strong>
            <p>Serverstand Revision {conflict.boardRevision}. Dein Entwurf bleibt lokal und überschreibt ihn nicht stillschweigend.</p>
            <div className="challenge-conflict-preview">
              <span>Aktueller Serverstand:</span>
              {conflict.challenges.length === 0 ? <em>leer</em> : conflict.challenges.map((challenge) => <span key={challenge.id}>{challenge.title}</span>)}
            </div>
            <div className="challenge-conflict-actions">
              <button className="button button--primary" onClick={() => applySnapshot(conflict, "Aktueller Serverstand übernommen.")} type="button">Serverstand übernehmen</button>
              <button className="button button--quiet" onClick={() => void save(true)} type="button">Eigenen Entwurf speichern und Fremdstand ersetzen</button>
            </div>
          </div>
        </section>
      )}

      {error !== "" && <p className="challenge-board-error" role="alert">{error}</p>}
      {message !== "" && <p className="challenge-board-success" aria-live="polite">{message}</p>}

      <div className="challenge-board-toolbar">
        <div>
          <strong>{String(drafts.length)} / 30 Einträge</strong>
          <span>Weglassen löscht einen Eintrag. Die Reihenfolge wird beim Speichern serverseitig lückenlos gemacht.</span>
        </div>
        <button
          className="button button--quiet"
          disabled={drafts.length >= 30 || saving || !online}
          onClick={() => {
            setDrafts((current) => [...current, defaultDraft(current.length)]);
            setMessage("");
          }}
          type="button"
        >
          <Plus size={16} /> Challenge anlegen
        </button>
      </div>

      <div className="challenge-board-list" aria-label="Challenge-Definitionen">
        {drafts.length === 0 && <p className="challenge-board-empty-copy">Noch keine Challenges. Lege den ersten Eintrag an.</p>}
        {drafts.map((draft, index) => (
          <ChallengeRow
            draft={draft}
            disabled={saving || !online}
            index={index}
            key={draft.key}
            onChange={(patch) => updateDraft(draft.key, patch)}
            onDelete={() => {
              setDrafts((current) => current
                .filter((item) => item.key !== draft.key)
                .map((item, sortOrder) => ({ ...item, sortOrder })));
              setMessage("");
            }}
            onDragStart={() => setDraggedKey(draft.key)}
            onDrop={() => {
              const from = drafts.findIndex((item) => item.key === draggedKey);
              const to = drafts.findIndex((item) => item.key === draft.key);
              setDrafts((current) => reorder(current, from, to));
              setDraggedKey(null);
            }}
            onMove={(to) => moveDraft(draft.key, to)}
            total={drafts.length}
          />
        ))}
      </div>

      {notices.length > 0 && (
        <aside aria-label="Folgen des Speicherns" className="challenge-merge-notices" aria-live="polite">
          <div className="challenge-notice-icon"><Info size={19} /></div>
          <div>
            <strong>Folgen dieses Speicherns</strong>
            <ul>
              {notices.map((notice) => <li data-notice-kind={notice.kind} key={notice.key}>{notice.message}</li>)}
            </ul>
          </div>
        </aside>
      )}

      <footer className="challenge-board-save-bar">
        <span className={dirty ? "save-dirty" : ""} aria-live="polite">
          {dirty ? "Ungespeicherte Board-Änderungen" : "Board ist veröffentlicht"}
        </span>
        <button
          aria-label="Challenge-Board speichern"
          className="button button--save"
          disabled={!dirty || saving || !online || conflict !== null}
          onClick={() => void save()}
          type="button"
        >
          <Save size={17} /> {saving ? "Board wird gespeichert …" : "Board speichern"}
        </button>
      </footer>
    </section>
  );
};
