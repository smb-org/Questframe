import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Download,
  GripVertical,
  Info,
  Maximize2,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { ChallengeUpdate } from "../../../shared/contracts/win-challenges";
import { decodeChallengeSet, encodeChallengeSet } from "../domain/set-codec";
import { downloadChallengeSet, readChallengeSetFile } from "../../../admin/ui/challengeSetFiles";
import {
  boardSaveRequestSchema,
  challengeBoardSnapshotSchema,
  challengeSetNameSchema,
  type BoardSaveRequest,
  type BoardSaveResponse,
  type ChallengeBoardSnapshot,
  type ChallengeDefinition,
  type Challenge,
  type ChallengeSetSummary,
  type ChallengeSetV1,
} from "../contracts/schemas";
import { maxCountForKind } from "../contracts/predicates";
import type { ChallengeSetProgress } from "../domain/set-codec";

export type ChallengeBoardSubscription = {
  onChallengeUpdate: (update: ChallengeUpdate) => void;
  onOnlineChange?: (online: boolean) => void;
};

export type ChallengeBoardApi = {
  load: () => Promise<ChallengeBoardSnapshot>;
  save: (request: BoardSaveRequest) => Promise<BoardSaveResponse>;
  listSets?: () => Promise<ChallengeSetSummary[]>;
  getSet?: (setId: string) => Promise<ChallengeSetV1>;
  saveSet?: (request: { name: string; includeProgress: boolean; setId?: string }) => Promise<ChallengeSetSummary>;
  deleteSet?: (setId: string) => Promise<string>;
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
  kind: Challenge["kind"];
  unit: Challenge["unit"];
  step: Challenge["step"];
  targetCount: number | null;
  timerTotalMs: number | null;
  sortOrder: number;
  hidden: boolean;
  currentCount: number;
  bestCount: number;
  state: Challenge["state"];
  timerEndsAt: string | null;
  timerRemainMs: number | null;
  completedAt: string | null;
};

type MergeNotice = {
  key: string;
  kind: "retained-count" | "clamped-count" | "timer-removed" | "timer-changed";
  message: string;
};

type ActiveSet = {
  id: string | null;
  name: string;
  fileName: string | null;
  type: "file" | "user" | "autosave";
  hasProgress: boolean;
};

const snapshotFromUpdate = (update: ChallengeUpdate): ChallengeBoardSnapshot => {
  return {
    eventSeq: update.eventSeq,
    boardRevision: update.boardRevision,
    settingsRevision: update.settingsRevision,
    settings: update.settings,
    challenges: update.challenges,
  };
};

const draftFromChallenge = (challenge: Challenge): ChallengeDraft => ({
  key: challenge.id,
  identity: { id: challenge.id },
  title: challenge.title,
  kind: challenge.kind,
  unit: challenge.unit,
  step: challenge.step,
  targetCount: challenge.targetCount,
  timerTotalMs: challenge.timerTotalMs,
  sortOrder: challenge.sortOrder,
  hidden: challenge.hidden,
  currentCount: challenge.currentCount,
  bestCount: challenge.bestCount,
  state: challenge.state,
  timerEndsAt: challenge.timerEndsAt,
  timerRemainMs: challenge.timerRemainMs,
  completedAt: challenge.completedAt,
});

const draftsFromSnapshot = (snapshot: ChallengeBoardSnapshot): ChallengeDraft[] =>
  [...snapshot.challenges]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map(draftFromChallenge);

const draftsFromDefinitions = (
  definitions: readonly ChallengeDefinition[],
  progress: readonly (ChallengeSetProgress | null)[] | null = null,
): ChallengeDraft[] => definitions.map((definition, sortOrder) => {
    const clientId = "clientId" in definition ? definition.clientId : clientIdForNewChallenge();
    const savedProgress = progress?.[sortOrder] ?? null;
    return {
      key: clientId,
      identity: { clientId },
      title: definition.title,
      kind: definition.kind,
      unit: definition.unit,
      step: definition.step,
      targetCount: definition.targetCount,
      timerTotalMs: definition.timerTotalMs,
      sortOrder,
      hidden: definition.hidden,
      currentCount: savedProgress?.currentCount ?? 0,
      bestCount: savedProgress?.bestCount ?? 0,
      state: savedProgress?.state ?? "pending",
      timerEndsAt: null,
      timerRemainMs: savedProgress?.timerRemainMs ?? null,
      completedAt: savedProgress?.completedAt ?? null,
    };
  });

const challengeForSetExport = (
  draft: ChallengeDraft,
  saved: Challenge | undefined,
  now: string,
): Challenge => ({
  id: saved?.id ?? draft.key,
  title: draft.title,
  kind: draft.kind,
  unit: draft.unit,
  controlKey: saved?.controlKey ?? "DRAFT",
  targetCount: draft.targetCount,
  timerTotalMs: draft.timerTotalMs,
  sortOrder: draft.sortOrder,
  step: draft.step,
  bestCount: saved?.bestCount ?? draft.bestCount,
  hidden: draft.hidden,
  currentCount: draft.currentCount,
  state: draft.state,
  timerEndsAt: draft.timerEndsAt,
  timerRemainMs: draft.timerRemainMs,
  completedAt: saved?.completedAt ?? draft.completedAt,
  createdAt: saved?.createdAt ?? now,
  updatedAt: saved?.updatedAt ?? now,
});

const definitionFromDraft = (draft: ChallengeDraft): ChallengeDefinition => {
  const fields = {
    title: draft.title,
    kind: draft.kind,
    unit: draft.unit,
    targetCount: draft.targetCount,
    timerTotalMs: draft.timerTotalMs,
    sortOrder: draft.sortOrder,
    step: draft.step,
    hidden: draft.hidden,
  };
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
    if (draft.kind !== "measure" && draft.targetCount !== null && draft.currentCount > draft.targetCount) {
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
  kind: "counter",
  unit: null,
  step: 1,
  targetCount: null,
  timerTotalMs: null,
  sortOrder,
  hidden: false,
  currentCount: 0,
  bestCount: 0,
  state: "pending",
  timerEndsAt: null,
  timerRemainMs: null,
  completedAt: null,
});

type ChallengeRowLayout = "stacked" | "compact";

type ChallengeRowProps = {
  draft: ChallengeDraft;
  index: number;
  total: number;
  disabled: boolean;
  numbered: boolean;
  number: number | undefined;
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
  numbered,
  number,
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
          <span className="challenge-board-number-label">{numbered && number !== undefined && <b>{number}</b>}<span className="sr-only">Challenge</span></span>
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
              max={maxCountForKind(draft.kind)}
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
          <span className="challenge-board-number-label">{numbered && number !== undefined && <b>{number}</b>} Challenge</span>
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
                max={maxCountForKind(draft.kind)}
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
  numbered: boolean;
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
  numbered,
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
        numbered={numbered}
        number={numbered && !draft.hidden ? drafts.slice(0, index + 1).filter((candidate) => !candidate.hidden).length : undefined}
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

type ChallengeSetImportConfirmationProps = {
  fileName: string | null;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
};

const ChallengeSetImportConfirmation = ({
  fileName,
  triggerRef,
  onCancel,
  onConfirm,
}: ChallengeSetImportConfirmationProps) => {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (fileName !== null) {
      confirmRef.current?.focus();
      wasOpenRef.current = true;
    } else if (wasOpenRef.current) {
      triggerRef.current?.focus();
      wasOpenRef.current = false;
    }
  }, [fileName, triggerRef]);

  if (fileName === null) return null;

  return (
    <div className="effect-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        aria-describedby="challenge-set-import-confirm-copy"
        aria-labelledby="challenge-set-import-confirm-heading"
        aria-modal="true"
        className="effect-flyover challenge-set-confirm-flyover"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="effect-flyover-header">
          <div>
            <span className="eyebrow">Set-Datei</span>
            <h2 id="challenge-set-import-confirm-heading">Ungespeicherte Änderungen</h2>
          </div>
          <button aria-label="Importdialog schließen" className="icon-button" onClick={onCancel} type="button"><X size={18} /></button>
        </header>
        <p className="challenge-set-confirm-copy" id="challenge-set-import-confirm-copy">
          „{fileName}“ ersetzt den lokalen Board-Entwurf. Noch nicht gespeicherte Änderungen gehen verloren.
        </p>
        <footer className="effect-actions">
          <button className="button button--quiet" onClick={onCancel} type="button">Abbrechen</button>
          <button className="button button--primary" onClick={onConfirm} ref={confirmRef} type="button">Import ersetzen</button>
        </footer>
      </section>
    </div>
  );
};

type PendingServerSet = {
  id: string;
  payload: ChallengeSetV1;
  summary: ChallengeSetSummary | null;
};

const ChallengeSetLoadConfirmation = ({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingServerSet | null;
  onCancel: () => void;
  onConfirm: () => void;
}) => {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (pending !== null) confirmRef.current?.focus();
  }, [pending]);

  if (pending === null) return null;
  const progressLabel = pending.summary?.hasProgress === true
    ? "mit Stand"
    : "ohne Stand";
  return (
    <div className="effect-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        aria-describedby="challenge-set-load-preview-copy"
        aria-labelledby="challenge-set-load-preview-heading"
        aria-modal="true"
        className="effect-flyover challenge-set-confirm-flyover"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="effect-flyover-header">
          <div>
            <span className="eyebrow">Server-Set</span>
            <h2 id="challenge-set-load-preview-heading">Set laden?</h2>
          </div>
          <button aria-label="Set-Vorschau schließen" className="icon-button" onClick={onCancel} type="button"><X size={18} /></button>
        </header>
        <div className="challenge-set-confirm-copy" id="challenge-set-load-preview-copy">
          <strong>{pending.payload.name}</strong>
          <p>{String(pending.payload.challenges.length)} Aufgaben · {progressLabel}</p>
          <ul className="challenge-set-preview-list">
            {pending.payload.challenges.slice(0, 6).map((challenge) => <li key={`${pending.id}-${String(challenge.sortOrder)}`}>{challenge.title}</li>)}
            {pending.payload.challenges.length > 6 && <li>und {String(pending.payload.challenges.length - 6)} weitere …</li>}
          </ul>
          <p>Der Entwurf im Board wird ersetzt. Die Veröffentlichung erfolgt erst über die globale Speicherleiste.</p>
        </div>
        <footer className="effect-actions">
          <button className="button button--quiet" onClick={onCancel} type="button">Abbrechen</button>
          <button className="button button--primary" onClick={onConfirm} ref={confirmRef} type="button">Set in Entwurf laden</button>
        </footer>
      </section>
    </div>
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
  const [activeSet, setActiveSet] = useState<ActiveSet | null>(null);
  const [setFileState, setSetFileState] = useState<"idle" | "reading">("idle");
  const [setFileError, setSetFileError] = useState("");
  const [setFileMessage, setSetFileMessage] = useState("");
  const [pendingSetSwitch, setPendingSetSwitch] = useState(false);
  const [pendingSetId, setPendingSetId] = useState<string | null>(null);
  const [serverSets, setServerSets] = useState<ChallengeSetSummary[]>([]);
  const [setSelection, setSetSelection] = useState("");
  const [setName, setSetName] = useState("");
  const [includeProgress, setIncludeProgress] = useState(true);
  const [setBusy, setSetBusy] = useState(false);
  const [pendingServerSet, setPendingServerSet] = useState<PendingServerSet | null>(null);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const snapshotRef = useRef<ChallengeBoardSnapshot | null>(null);
  const draftsRef = useRef<ChallengeDraft[]>([]);
  const savingRef = useRef(false);
  const draftsPendingReconciliationRef = useRef(false);
  const fullscreenTriggerRef = useRef<HTMLButtonElement | null>(null);
  const setFileInputRef = useRef<HTMLInputElement | null>(null);
  const setImportTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    snapshotRef.current = snapshot;
    draftsRef.current = drafts;
  }, [drafts, snapshot]);

  const dirty = useMemo(
    () => snapshot !== null && (pendingSetSwitch || !sameDefinitions(drafts, draftsFromSnapshot(snapshot))),
    [drafts, pendingSetSwitch, snapshot],
  );
  const notices = useMemo(
    () => (snapshot === null ? [] : noticesFor(drafts, snapshot)),
    [drafts, snapshot],
  );
  const numbered = challengeUpdate?.settings.numbered === true;

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
      setActiveSet(null);
      setPendingSetSwitch(false);
      setPendingSetId(null);
      setSetSelection("");
      setSetFileError("");
      setSetFileMessage("");
      setConflict(null);
    }
  }, []);

  const applySnapshot = useCallback((next: ChallengeBoardSnapshot, nextMessage = "") => {
    snapshotRef.current = next;
    setSnapshot(next);
    setDrafts(draftsFromSnapshot(next));
    setActiveSet(null);
    setPendingSetSwitch(false);
    setPendingSetId(null);
    setSetSelection("");
    setSetFileError("");
    setSetFileMessage("");
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

  const reloadSets = useCallback(async (): Promise<void> => {
    if (api.listSets === undefined) return;
    try {
      setServerSets(await api.listSets());
    } catch {
      setSetFileError("Gespeicherte Sets konnten nicht geladen werden.");
    }
  }, [api]);

  useEffect(() => {
    if (api.listSets === undefined) return;
    let disposed = false;
    api.listSets()
      .then((sets) => {
        if (!disposed) setServerSets(sets);
      })
      .catch(() => {
        if (!disposed) setSetFileError("Gespeicherte Sets konnten nicht geladen werden.");
      });
    return () => {
      disposed = true;
    };
  }, [api]);

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

  const readImportedSet = async (file: File): Promise<void> => {
    setSetFileState("reading");
    setSetFileError("");
    setSetFileMessage("");
    try {
      const result = await readChallengeSetFile(file);
      const decoded = decodeChallengeSet(result.payload);
      setDrafts(draftsFromDefinitions(decoded.definitions));
      setActiveSet({ id: null, name: result.payload.name, fileName: result.fileName, type: "file", hasProgress: false });
      setPendingSetSwitch(true);
      setPendingSetId(null);
      setSetSelection("");
      setSetName(result.payload.name);
      setMessage("");
      setError("");
      setSetFileMessage(`Set-Datei geladen: ${result.fileName}. Entwurf noch nicht veröffentlicht.`);
    } catch (caught) {
      setSetFileError(caught instanceof Error ? caught.message : "Set-Datei konnte nicht gelesen werden.");
    } finally {
      setSetFileState("idle");
    }
  };

  const importSet = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (file === undefined) return;
    if (dirty) {
      setPendingImportFile(file);
      return;
    }
    void readImportedSet(file);
  };

  const confirmImport = (): void => {
    const file = pendingImportFile;
    setPendingImportFile(null);
    if (file !== null) void readImportedSet(file);
  };

  const loadServerSet = async (setId: string): Promise<void> => {
    if (api.getSet === undefined || setId === "") return;
    if (dirty && !window.confirm("Der Set-Entwurf ersetzt ungespeicherte Board-Änderungen. Fortfahren?")) {
      setSetSelection(activeSet?.id ?? "");
      return;
    }
    setSetBusy(true);
    setSetFileError("");
    setSetFileMessage("");
    try {
      const payload = await api.getSet(setId);
      setPendingServerSet({
        id: setId,
        payload,
        summary: serverSets.find((set) => set.id === setId) ?? null,
      });
      setMessage("");
      setError("");
      setSetFileMessage("Vorschau bereit. Das Set wurde noch nicht in den Entwurf geladen.");
    } catch (caught) {
      setSetFileError(caught instanceof Error ? caught.message : "Set konnte nicht geladen werden.");
      setSetSelection(activeSet?.id ?? "");
    } finally {
      setSetBusy(false);
    }
  };

  const cancelServerSetLoad = (): void => {
    setPendingServerSet(null);
    setSetSelection(activeSet?.id ?? "");
  };

  const confirmServerSetLoad = (): void => {
    if (pendingServerSet === null) return;
    const { id, payload, summary } = pendingServerSet;
    const decoded = decodeChallengeSet(payload, { preserveProgress: true });
    setDrafts(draftsFromDefinitions(decoded.definitions, decoded.progress));
    setActiveSet({
      id,
      name: payload.name,
      fileName: null,
      type: summary?.type ?? "user",
      hasProgress: summary?.hasProgress ?? payload.challenges.some(({ progress }) => progress !== undefined),
    });
    setSetName(payload.name);
    setPendingSetId(id);
    setPendingSetSwitch(true);
    setPendingServerSet(null);
    setMessage("");
    setError("");
    setSetFileMessage("Server-Set geladen. Entwurf noch nicht veröffentlicht.");
  };

  const saveServerSet = async (): Promise<void> => {
    if (api.saveSet === undefined || drafts.length === 0 || setBusy || !effectiveOnline) return;
    const parsedName = challengeSetNameSchema.safeParse(setName);
    if (!parsedName.success) {
      setSetFileError("Set-Name muss 1–24 Zeichen lang sein.");
      return;
    }
    setSetBusy(true);
    setSetFileError("");
    setSetFileMessage("");
    try {
      if (dirty) {
        const boardResult = await save();
        if (!boardResult.ok) return;
      }
      const summary = await api.saveSet({
        name: parsedName.data,
        includeProgress,
        ...(activeSet?.type === "user" && activeSet.id !== null ? { setId: activeSet.id } : {}),
      });
      setActiveSet({ id: summary.id, name: summary.name, fileName: null, type: summary.type, hasProgress: summary.hasProgress });
      setSetSelection(summary.id);
      setSetName(summary.name);
      setSetFileMessage("Set gespeichert.");
      await reloadSets();
    } catch (caught) {
      setSetFileError(caught instanceof Error ? caught.message : "Set konnte nicht gespeichert werden.");
    } finally {
      setSetBusy(false);
    }
  };

  const deleteServerSet = async (): Promise<void> => {
    if (api.deleteSet === undefined || activeSet?.type !== "user" || activeSet.id === null || setBusy) return;
    if (!window.confirm(`Set „${activeSet.name}“ löschen?`)) return;
    setSetBusy(true);
    setSetFileError("");
    try {
      await api.deleteSet(activeSet.id);
      setActiveSet(null);
      setSetSelection("");
      setSetName("");
      setSetFileMessage("Set gelöscht.");
      await reloadSets();
    } catch (caught) {
      setSetFileError(caught instanceof Error ? caught.message : "Set konnte nicht gelöscht werden.");
    } finally {
      setSetBusy(false);
    }
  };

  const exportSet = (): void => {
    if (snapshot === null || drafts.length === 0 || setFileState === "reading") return;
    const now = new Date();
    const savedById = new Map(snapshot.challenges.map((challenge) => [challenge.id, challenge]));
    const name = activeSet?.name ?? "Challenge-Board";
    const payload = encodeChallengeSet(
      {
        challenges: drafts.map((draft) => {
          const saved = "id" in draft.identity ? savedById.get(draft.identity.id) : undefined;
          return challengeForSetExport(draft, saved, now.toISOString());
        }),
      },
      { name, createdAt: now.toISOString(), now: now.toISOString(), includeProgress: false },
    );
    downloadChallengeSet(payload, now);
    setSetFileMessage("Set-Datei exportiert.");
    setSetFileError("");
  };

  const updateDraft = (key: string, patch: Partial<ChallengeDraft>) => {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
    setMessage("");
    setError("");
    setSetFileMessage("");
  };

  const moveDraft = (key: string, to: number) => {
    setDrafts((current) => {
      const from = current.findIndex((draft) => draft.key === key);
      return reorder(current, from, to);
    });
    setMessage("");
    setSetFileMessage("");
  };

  const addDraft = () => {
    setDrafts((current) => [...current, defaultDraft(current.length)]);
    setMessage("");
    setSetFileMessage("");
  };

  const deleteDraft = (key: string) => {
    setDrafts((current) => current
      .filter((item) => item.key !== key)
      .map((item, sortOrder) => ({ ...item, sortOrder })));
    setMessage("");
    setSetFileMessage("");
  };

  const dropDraft = (key: string) => {
    setDrafts((current) => {
      const from = current.findIndex((item) => item.key === draggedKey);
      const to = current.findIndex((item) => item.key === key);
      return reorder(current, from, to);
    });
    setDraggedKey(null);
    setSetFileMessage("");
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
        ...(pendingSetSwitch ? { reason: "set-switch" } : {}),
        ...(pendingSetId === null ? {} : { setId: pendingSetId }),
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
      setPendingSetSwitch(false);
      setPendingSetId(null);
      setSetFileMessage(activeSet === null ? "" : "Entwurf veröffentlicht.");
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

      <div aria-label="Challenge-Sets" className="challenge-set-bar" role="group">
        <div className="challenge-set-summary">
          <span className="eyebrow">Aktives Set</span>
          <strong className={activeSet !== null && !dirty ? "challenge-set-name challenge-set-name--published" : "challenge-set-name"}>
            {activeSet === null ? "Noch kein Set" : `${activeSet.name}${dirty ? " · geändert" : ""}`}
          </strong>
          {activeSet === null
            ? <small>Sichere das aktuelle Board als Datei.</small>
            : activeSet.type === "file"
              ? <small>Datei: {activeSet.fileName}</small>
              : <small>{activeSet.type === "autosave" ? "Autosicherung" : "Server-Set"}{activeSet.hasProgress ? " · mit Stand" : " · ohne Stand"}</small>}
        </div>
        {api.listSets !== undefined && api.getSet !== undefined && (
          <div className="challenge-set-server-controls">
            <label>
              <span className="challenge-set-control-label">Gespeicherte Sets</span>
              <select
                aria-label="Gespeichertes Set laden"
                disabled={setBusy || saving || setFileState === "reading"}
                onChange={(event) => {
                  setSetSelection(event.currentTarget.value);
                  void loadServerSet(event.currentTarget.value);
                }}
                value={setSelection}
              >
                <option value="">Set laden …</option>
                {serverSets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {set.name}{set.hasProgress ? " · mit Stand" : " · ohne Stand"}
                  </option>
                ))}
              </select>
            </label>
            {api.saveSet !== undefined && (
              <>
                <label>
                  <span className="challenge-set-control-label">Name</span>
                  <input
                    aria-label="Name des Server-Sets"
                    maxLength={24}
                    onChange={(event) => setSetName(event.currentTarget.value)}
                    placeholder="Neues Set"
                    type="text"
                    value={setName}
                  />
                </label>
                <label className="challenge-set-progress-toggle">
                  <input
                    checked={includeProgress}
                    onChange={(event) => setIncludeProgress(event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <span>Stand mitspeichern</span>
                </label>
                <button
                  className="button button--quiet challenge-set-action"
                  disabled={drafts.length === 0 || setBusy || saving || !effectiveOnline}
                  onClick={() => void saveServerSet()}
                  type="button"
                >
                  Set speichern
                </button>
                {api.deleteSet !== undefined && activeSet?.type === "user" && (
                  <button
                    aria-label="Aktives Server-Set löschen"
                    className="button button--quiet challenge-set-action"
                    disabled={setBusy || saving || !effectiveOnline}
                    onClick={() => void deleteServerSet()}
                    type="button"
                  >
                    <Trash2 size={16} /> Löschen
                  </button>
                )}
              </>
            )}
          </div>
        )}
        <div className="challenge-set-actions">
          <input
            accept="application/json,.json"
            aria-label="Set-Datei auswählen"
            hidden
            onChange={importSet}
            ref={setFileInputRef}
            type="file"
          />
          <button
            className="button button--quiet challenge-set-action"
            disabled={saving || setFileState === "reading"}
            onClick={() => setFileInputRef.current?.click()}
            ref={setImportTriggerRef}
            type="button"
          >
            <Upload size={16} /> Set importieren
          </button>
          <button
            className="button button--primary challenge-set-action"
            disabled={drafts.length === 0 || saving || setFileState === "reading"}
            onClick={exportSet}
            title={drafts.length === 0 ? "Das Board ist leer." : undefined}
            type="button"
          >
            <Download size={16} /> {drafts.length === 0 ? "Aktuelles Board als Set sichern" : "Set exportieren"}
          </button>
        </div>
        {setFileState === "reading" && <span aria-live="polite" className="challenge-set-status">Set-Datei wird gelesen …</span>}
        {setFileError !== "" && <span className="challenge-set-status challenge-set-status--error" role="alert">{setFileError}</span>}
        {setFileMessage !== "" && setFileState === "idle" && <span aria-live="polite" className="challenge-set-status challenge-set-status--success">{setFileMessage}</span>}
        {drafts.length === 0 && <span className="challenge-set-status challenge-set-status--hint">Export nicht verfügbar: Das Board ist leer.</span>}
      </div>

      <ChallengeSetImportConfirmation
        fileName={pendingImportFile?.name ?? null}
        onCancel={() => setPendingImportFile(null)}
        onConfirm={confirmImport}
        triggerRef={setImportTriggerRef}
      />
      <ChallengeSetLoadConfirmation
        onCancel={cancelServerSetLoad}
        onConfirm={confirmServerSetLoad}
        pending={pendingServerSet}
      />

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
        numbered={numbered}
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
        numbered={numbered}
        triggerRef={fullscreenTriggerRef}
      />
    </section>
  );
};
