import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  GripVertical,
  Info,
  Maximize2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

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

// Fuer die globale Speicherleiste (AdminWorkspace): Dirty-Zustand und ein save()-Griff,
// der Erfolg/Konflikt/Fehler direkt zurueckgibt statt ueber verzoegerten React-State.
export type ChallengeBoardSaveHandle = {
  dirty: boolean;
  save: () => Promise<{ ok: boolean; conflict: boolean; message?: string }>;
};

type ChallengeDraft = {
  key: string;
  identity: { id: string } | { clientId: string };
  title: string;
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

const definitionFieldsOnly = (draft: ChallengeDraft) => ({
  title: draft.title,
  targetCount: draft.targetCount,
  timerTotalMs: draft.timerTotalMs,
  hidden: draft.hidden,
});

const sameFieldsIgnoringIdentity = (
  left: readonly ChallengeDraft[],
  right: readonly ChallengeDraft[],
): boolean =>
  left.length === right.length &&
  JSON.stringify(left.map(definitionFieldsOnly)) === JSON.stringify(right.map(definitionFieldsOnly));

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
  targetCount: null,
  timerTotalMs: null,
  sortOrder,
  hidden: false,
  currentCount: 0,
  state: "pending",
  timerEndsAt: null,
});

type ChallengeRowLayout = "stacked" | "compact";

type ChallengeRowProps = {
  draft: ChallengeDraft;
  index: number;
  total: number;
  disabled: boolean;
  layout?: ChallengeRowLayout;
  onChange: (patch: Partial<ChallengeDraft>) => void;
  onDelete: () => void;
  onMove: (to: number) => void;
  onDragStart: () => void;
  onDrop: () => void;
};

const ChallengeRow = ({
  draft,
  index,
  total,
  disabled,
  layout = "stacked",
  onChange,
  onDelete,
  onMove,
  onDragStart,
  onDrop,
}: ChallengeRowProps) => {
  const hasTarget = draft.targetCount !== null;
  const hasTimer = draft.timerTotalMs !== null;
  const orderControls = (
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
  );
  const runtime = (
    <div className="challenge-row-runtime" aria-label={`${draft.title} Laufzeitstand`}>
      <span className={`challenge-state challenge-state--${draft.state}`}>
        <i aria-hidden="true" /> {draft.state === "active" ? "läuft" : draft.state === "done" ? "erledigt" : "offen"}
      </span>
      <strong>
        {draft.targetCount === null
          ? `Stand ${String(draft.currentCount)}`
          : `${String(draft.currentCount)} / ${String(draft.targetCount)}`}
      </strong>
      {layout === "stacked" && (
        <>
          <button
            aria-checked={!draft.hidden}
            aria-label={`${draft.title} ${draft.hidden ? "einblenden" : "ausblenden"}`}
            className={`challenge-hidden-toggle ${!draft.hidden ? "is-on" : "is-off"}`}
            disabled={disabled || draft.state === "done"}
            onClick={() => onChange({ hidden: !draft.hidden })}
            role="switch"
            title={draft.state === "done" ? "Erledigte Challenges können nicht ausgeblendet werden." : "Challenge im OBS-Overlay ein- oder ausblenden."}
            type="button"
          >
            <span>{draft.hidden ? "Aus" : "Sichtbar"}</span>
            <i aria-hidden="true" />
          </button>
          {draft.state === "done" && <small>Erledigte Challenges bleiben sichtbar.</small>}
          {draft.targetCount === null && draft.currentCount > 0 && <small>Stand bleibt erhalten</small>}
        </>
      )}
    </div>
  );
  const visibilityToggle = (
    <button
      aria-checked={!draft.hidden}
      aria-label={`${draft.title} ${draft.hidden ? "einblenden" : "ausblenden"}`}
      className={`challenge-hidden-toggle ${!draft.hidden ? "is-on" : "is-off"}`}
      disabled={disabled || draft.state === "done"}
      onClick={() => onChange({ hidden: !draft.hidden })}
      role="switch"
      title={draft.state === "done" ? "Erledigte Challenges können nicht ausgeblendet werden." : "Challenge im OBS-Overlay ein- oder ausblenden."}
      type="button"
    >
      <span>{draft.hidden ? "Aus" : "Sichtbar"}</span>
      <i aria-hidden="true" />
    </button>
  );
  const deleteButton = (
    <button
      aria-label={`${draft.title} löschen`}
      className="icon-button challenge-delete"
      disabled={disabled}
      onClick={onDelete}
      type="button"
    >
      <Trash2 size={17} />
    </button>
  );

  if (layout === "compact") {
    return (
      <article
        className="challenge-board-row challenge-board-row--compact"
        draggable={!disabled}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          onDrop();
        }}
      >
        {orderControls}
        {runtime}
        <label className="challenge-field challenge-field--compact-title">
          <span className="sr-only">Challenge</span>
          <input
            disabled={disabled}
            maxLength={160}
            title={draft.title}
            type="text"
            value={draft.title}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </label>
        <label className="challenge-compact-field">
          <span>Ziel</span>
          <span className="challenge-compact-toggle-field">
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
        <label className="challenge-compact-field">
          <span>Timer</span>
          <span className="challenge-compact-toggle-field">
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
        {visibilityToggle}
        {deleteButton}
      </article>
    );
  }

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
      <div className="challenge-row-header">
        {orderControls}
        {runtime}
        {deleteButton}
      </div>
      <div className="challenge-row-fields">
        <label className="challenge-field challenge-field--title">
          <span>Challenge</span>
          <textarea
            disabled={disabled}
            maxLength={160}
            rows={2}
            value={draft.title}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </label>
        <fieldset aria-label="Ziel und Timer" className="challenge-row-goals">
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
        </fieldset>
      </div>
    </article>
  );
};

type ChallengeBoardListProps = {
  drafts: readonly ChallengeDraft[];
  disabled: boolean;
  layout?: ChallengeRowLayout;
  ariaLabel?: string;
  onChange: (key: string, patch: Partial<ChallengeDraft>) => void;
  onDelete: (key: string) => void;
  onMove: (key: string, to: number) => void;
  onDragStart: (key: string) => void;
  onDrop: (key: string) => void;
};

const ChallengeBoardList = ({
  drafts,
  disabled,
  layout = "stacked",
  ariaLabel = "Challenge-Definitionen",
  onChange,
  onDelete,
  onMove,
  onDragStart,
  onDrop,
}: ChallengeBoardListProps) => (
  <div aria-label={ariaLabel} className={`challenge-board-list${layout === "compact" ? " challenge-board-list--compact" : ""}`}>
    {drafts.length === 0 && <p className="challenge-board-empty-copy">Noch keine Challenges. Lege den ersten Eintrag an.</p>}
    {drafts.map((draft, index) => (
      <ChallengeRow
        draft={draft}
        disabled={disabled}
        index={index}
        key={draft.key}
        layout={layout}
        onChange={(patch) => onChange(draft.key, patch)}
        onDelete={() => onDelete(draft.key)}
        onDragStart={() => onDragStart(draft.key)}
        onDrop={() => onDrop(draft.key)}
        onMove={(to) => onMove(draft.key, to)}
        total={drafts.length}
      />
    ))}
  </div>
);

type ChallengeBoardFullscreenDialogProps = Omit<ChallengeBoardListProps, "ariaLabel" | "layout"> & {
  open: boolean;
  dirty: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onAdd: () => void;
};

const ChallengeBoardFullscreenDialog = ({
  open,
  dirty,
  triggerRef,
  onClose,
  onAdd,
  ...listProps
}: ChallengeBoardFullscreenDialogProps) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open) {
      if (typeof dialog.showModal === "function") {
        if (!dialog.open) dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
      dialog.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]")?.focus();
    } else if (wasOpenRef.current) {
      if (typeof dialog.close === "function") {
        if (dialog.open) dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
      triggerRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open, triggerRef]);

  return (
    <dialog
      aria-labelledby="challenge-board-fullscreen-heading"
      className="challenge-board-fullscreen-dialog"
      id="challenge-board-fullscreen"
      onClick={(event) => { if (event.target === dialogRef.current) onClose(); }}
      onClose={onClose}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}
      ref={dialogRef}
    >
      {open && <div className="challenge-board-fullscreen-dialog__content">
        <header className="challenge-board-fullscreen-dialog__header">
          <div>
            <span className="eyebrow">Übersicht</span>
            <h2 id="challenge-board-fullscreen-heading">Challenge-Board</h2>
            <p>Alle Einträge kompakt bearbeiten und per Drag-and-drop sortieren.</p>
          </div>
          <button aria-label="Vollbild schließen" className="icon-button" onClick={onClose} title="Vollbild schließen" type="button">
            <X size={18} />
          </button>
        </header>
        <div className="challenge-board-fullscreen-dialog__toolbar">
          <strong>{String(listProps.drafts.length)} / 30 Einträge</strong>
          <button
            className="button button--quiet"
            disabled={listProps.drafts.length >= 30 || listProps.disabled}
            onClick={onAdd}
            type="button"
          >
            <Plus size={16} /> Challenge anlegen
          </button>
        </div>
        <ChallengeBoardList {...listProps} ariaLabel="Challenge-Definitionen im Vollbild" layout="compact" />
        <footer className="challenge-board-fullscreen-dialog__footer">
          <span className={dirty ? "save-dirty" : ""} aria-live="polite">
            {dirty ? "Ungespeicherte Board-Änderungen" : "Board ist veröffentlicht"}
          </span>
          <span>Speichern über die globale Speicherleiste.</span>
        </footer>
      </div>}
    </dialog>
  );
};

export const ChallengeBoard = ({
  api,
  onOnlineChange,
  challengeUpdate,
  online: onlineOverride,
  onHandleChange,
}: {
  api: ChallengeBoardApi;
  onOnlineChange?: (online: boolean) => void;
  challengeUpdate?: ChallengeUpdate | null;
  online?: boolean;
  onHandleChange?: (handle: ChallengeBoardSaveHandle) => void;
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
  const [fullscreen, setFullscreen] = useState(false);
  const snapshotRef = useRef<ChallengeBoardSnapshot | null>(null);
  const draftsRef = useRef<ChallengeDraft[]>([]);
  const savingRef = useRef(false);
  const draftsPendingReconciliationRef = useRef(false);
  const fullscreenTriggerRef = useRef<HTMLButtonElement | null>(null);

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

  const applyChallengeUpdate = useCallback((update: ChallengeUpdate) => {
    const incoming = snapshotFromUpdate(update);
    const current = snapshotRef.current;
    if (current !== null && incoming.boardRevision <= current.boardRevision) return;
    if (savingRef.current && sameFieldsIgnoringIdentity(draftsRef.current, draftsFromSnapshot(incoming))) {
      snapshotRef.current = incoming;
      setSnapshot(incoming);
      draftsPendingReconciliationRef.current = true;
      return;
    }
    draftsPendingReconciliationRef.current = false;
    snapshotRef.current = incoming;
    const currentDrafts = draftsRef.current;
    const isDirty = current !== null && !sameDefinitions(currentDrafts, draftsFromSnapshot(current));
    setSnapshot(incoming);
    if (isDirty) {
      setConflict(incoming);
    } else {
      setDrafts(draftsFromSnapshot(incoming));
      setConflict(null);
    }
  }, []);

  const applySnapshot = useCallback((next: ChallengeBoardSnapshot, nextMessage = "") => {
    snapshotRef.current = next;
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
        const current = snapshotRef.current;
        if (current === null || loaded.boardRevision > current.boardRevision) applySnapshot(loaded);
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
      onChallengeUpdate: applyChallengeUpdate,
    });
  }, [api, applyChallengeUpdate, onOnlineChange]);

  useEffect(() => {
    if (challengeUpdate !== undefined && challengeUpdate !== null) {
      applyChallengeUpdate(challengeUpdate);
    }
  }, [applyChallengeUpdate, challengeUpdate]);

  const effectiveOnline = onlineOverride ?? online;

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

  const addDraft = () => {
    setDrafts((current) => [...current, defaultDraft(current.length)]);
    setMessage("");
  };

  const deleteDraft = (key: string) => {
    setDrafts((current) => current
      .filter((item) => item.key !== key)
      .map((item, sortOrder) => ({ ...item, sortOrder })));
    setMessage("");
  };

  const dropDraft = (key: string) => {
    setDrafts((current) => {
      const from = current.findIndex((item) => item.key === draggedKey);
      const to = current.findIndex((item) => item.key === key);
      return reorder(current, from, to);
    });
    setDraggedKey(null);
  };

  const save = async (replaceForeignBoard = false): Promise<{ ok: boolean; conflict: boolean; message?: string }> => {
    if (snapshot === null || !dirty || saving || !effectiveOnline) return { ok: false, conflict: false, message: "Nicht speicherbar." };
    if (conflict !== null && !replaceForeignBoard) {
      const conflictMessage = "Jemand anderes hat das Board gespeichert. Bitte eine Konfliktaktion wählen.";
      setError(conflictMessage);
      return { ok: false, conflict: true, message: conflictMessage };
    }
    const baseBoardRevision = replaceForeignBoard && conflict !== null
      ? conflict.boardRevision
      : snapshot.boardRevision;
    setSaving(true);
    savingRef.current = true;
    setMessage("");
    setError("");
    try {
      const request = boardSaveRequestSchema.parse({
        baseBoardRevision,
        challenges: definitionsFromDrafts(drafts),
      });
      const response = await api.save(request);
      // Derselbe Revisions-Guard wie in applyChallengeUpdate: waehrend unsere Antwort
      // unterwegs war, kann per Socket schon eine neuere boardRevision eingetroffen sein.
      // Eine verspaetete eigene Antwort darf diesen neueren lokalen Stand nicht
      // zurueckdrehen, sonst laeuft der naechste Save in einen falschen Konflikt.
      if (
        snapshotRef.current === null ||
        response.snapshot.boardRevision > snapshotRef.current.boardRevision ||
        draftsPendingReconciliationRef.current
      ) {
        draftsPendingReconciliationRef.current = false;
        const resolvedDrafts = applyCreatedIds(drafts, response);
        setSnapshot(response.snapshot);
        setDrafts(resolvedDrafts);
        setConflict(null);
      }
      setMessage(`Board gespeichert · Revision ${String(response.snapshot.boardRevision)}.`);
      return { ok: true, conflict: false };
    } catch (caught) {
      const candidate = typeof caught === "object" && caught !== null
        ? caught as { code?: unknown; currentSnapshot?: unknown }
        : {};
      const currentSnapshot = candidate.code === "revision_conflict"
        ? snapshotFromUnknown(candidate.currentSnapshot)
        : null;
      if (currentSnapshot !== null) {
        const conflictMessage = "Jemand anderes hat gespeichert. Der aktuelle Serverstand ist unten sichtbar; dein Entwurf bleibt erhalten.";
        setConflict(currentSnapshot);
        setError(conflictMessage);
        return { ok: false, conflict: true, message: conflictMessage };
      }
      const messageText = caught instanceof Error ? caught.message : "Board konnte nicht gespeichert werden.";
      setError(messageText);
      return { ok: false, conflict: false, message: messageText };
    } finally {
      setSaving(false);
      savingRef.current = false;
      draftsPendingReconciliationRef.current = false;
    }
  };

  // Griff fuer die globale Speicherleiste: Dirty-Zustand direkt, save() ueber ein Ref,
  // damit der registrierte Handle nur bei Dirty-Wechsel neu erzeugt wird (sonst
  // Endlosschleife, da save() bei jedem Render eine neue Funktionsreferenz waere).
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; });
  useEffect(() => {
    onHandleChange?.({ dirty, save: () => saveRef.current() });
  }, [dirty, onHandleChange]);

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
          <span className={effectiveOnline ? "connection-state is-online" : "connection-state is-offline"}>
            <i aria-hidden="true" /> {effectiveOnline ? "Live verbunden" : "Offline"}
          </span>
          <button
            aria-controls="challenge-board-fullscreen"
            aria-expanded={fullscreen}
            aria-label="Board im Vollbild bearbeiten"
            className="icon-button challenge-board-fullscreen-trigger"
            onClick={() => setFullscreen((current) => !current)}
            ref={fullscreenTriggerRef}
            title="Vollbild"
            type="button"
          >
            <Maximize2 size={17} />
          </button>
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
          disabled={drafts.length >= 30 || saving || !effectiveOnline}
          onClick={addDraft}
          type="button"
        >
          <Plus size={16} /> Challenge anlegen
        </button>
      </div>

      <ChallengeBoardList
        drafts={drafts}
        disabled={saving || !effectiveOnline}
        onChange={updateDraft}
        onDelete={deleteDraft}
        onDragStart={setDraggedKey}
        onDrop={dropDraft}
        onMove={moveDraft}
      />

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

      {/* Kein modul-eigener Speichern-Button mehr: die globale Speicherleiste (AdminWorkspace)
          ist die einzige Speicher-Aktion. Status/Dirty-Anzeige bleibt fuer Sichtbarkeit. */}
      <footer className="challenge-board-save-bar">
        <span className={dirty ? "save-dirty" : ""} aria-live="polite">
          {dirty ? "Ungespeicherte Board-Änderungen" : "Board ist veröffentlicht"}
        </span>
      </footer>

      <ChallengeBoardFullscreenDialog
        dirty={dirty}
        disabled={saving || !effectiveOnline}
        drafts={drafts}
        onAdd={addDraft}
        onChange={updateDraft}
        onClose={() => setFullscreen(false)}
        onDelete={deleteDraft}
        onDragStart={setDraggedKey}
        onDrop={dropDraft}
        onMove={moveDraft}
        open={fullscreen}
        triggerRef={fullscreenTriggerRef}
      />
    </section>
  );
};
