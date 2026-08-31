/* The state hook is intentionally colocated with the extracted rail. */
/* eslint-disable react-refresh/only-export-components */

import {
  Activity,
  Check,
  ChevronDown,
  ImagePlus,
  MessageSquare,
  PawPrint,
  Plus,
  Radio,
  RotateCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import type {
  AuditEntry,
  BootstrapResponse,
  UndoTarget,
} from "../../shared/contracts/api";
import type {
  ActiveEffect,
  ChannelState,
  ChannelStateDraft,
  GroupMember,
  PortraitRef,
  ThemeId,
} from "../../shared/contracts/state";
import type { ChallengeUpdate } from "../../shared/contracts/win-challenges";
import { EFFECT_CATALOG, type EffectDefinition } from "../../shared/domain/effects";
import { HudRenderer } from "../../overlay/HudRenderer";
import { expiryToLocalInput, resolveLocalExpiry } from "../time";
import type { AdminApi, TwitchUser } from "../AdminWorkspace";
import { HUD_SCALE_OPTIONS, THEME_LABELS } from "./hudConstants";
import {
  applyOverlayTokenResponse,
  buildTokenUrl,
  copyObsUrl,
  mutateObsToken,
  type DockTokenStatus,
} from "./obsSetup";

const RESOURCE_PRESETS = [
  { name: "Wut", color: "#FF0000" },
  { name: "Mana", color: "#0000FF" },
  { name: "Energie", color: "#FFFF00" },
  { name: "Fokus", color: "#FF8040" },
  { name: "Ausdauer", color: "#22C55E" },
] as const;
const CUSTOM_RESOURCE = "Custom" as const;

const getResourceSelection = (resource: ChannelStateDraft["player"]["resource"]): string =>
  RESOURCE_PRESETS.find(
    (preset) => preset.name === resource.name && preset.color === resource.color.toUpperCase(),
  )?.name ?? CUSTOM_RESOURCE;

const toDraft = (state: ChannelState): ChannelStateDraft => {
  const {
    revision: _revision,
    overlayEnabled: _overlayEnabled,
    updatedAt: _updatedAt,
    updatedBy: _updatedBy,
    ...draft
  } = state;
  void [_revision, _overlayEnabled, _updatedAt, _updatedBy];
  return draft;
};

const uploadedHashes = (state: ChannelStateDraft | ChannelState): string[] => {
  const portraits = [
    state.player.portrait,
    state.pet?.portrait,
    ...state.group.map((member) => member.portrait),
  ];
  return [
    ...new Set(
      portraits.flatMap((portrait) =>
        portrait?.kind === "uploaded" ? [portrait.contentHash] : [],
      ),
    ),
  ];
};

const prependAuditEntry = (current: AuditEntry[], entry: AuditEntry): AuditEntry[] => {
  if (current.some((existing) => existing.id === entry.id)) return current;
  return [entry, ...current].slice(0, 50);
};

const toPreview = (draft: ChannelStateDraft, committed: ChannelState): ChannelState => ({
  ...draft,
  revision: committed.revision,
  overlayEnabled: committed.overlayEnabled,
  updatedAt: committed.updatedAt,
  updatedBy: committed.updatedBy,
});

const THEME_PREVIEW_NOW = Date.now();

const emptyDockTokenStatus = (): DockTokenStatus => ({
  exists: false,
  generation: 0,
  fingerprint: null,
  createdAt: null,
  lastUsedAt: null,
  connectedSockets: 0,
  token: null,
});

const ThemePreviewCard = ({
  theme,
  preview,
  previewMediaUrls,
}: {
  theme: ThemeId;
  preview: ChannelState;
  previewMediaUrls: ReadonlyMap<string, string>;
}) => {
  const previewState: ChannelState = {
    ...preview,
    themeId: theme,
    placement: { x: 0, y: 0, scale: 1 },
    effects: [],
    featuredEffectId: null,
    pet: null,
    group: [],
  };
  return (
    <div aria-hidden="true" className="theme-preview">
      <div className="theme-preview-inner">
        <HudRenderer
          autoFitPlayerName={false}
          forceVisible
          mediaUrls={previewMediaUrls}
          nowMilliseconds={THEME_PREVIEW_NOW}
          state={previewState}
        />
      </div>
    </div>
  );
};

type EffectFlyoverProps = {
  effect?: ActiveEffect | undefined;
  initialFeatured: boolean;
  timezone: string;
  onClose: () => void;
  onCommit: (effect: ActiveEffect, featured: boolean) => void;
};

const EffectFlyover = ({ effect, initialFeatured, timezone, onClose, onCommit }: EffectFlyoverProps) => {
  const initialDefinition = EFFECT_CATALOG.find((item) => item.id === effect?.catalogId);
  const [kind, setKind] = useState<"all" | "buff" | "debuff">("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<EffectDefinition | null>(initialDefinition ?? null);
  const [name, setName] = useState(effect?.name ?? initialDefinition?.name ?? "");
  const [description, setDescription] = useState(effect?.description ?? initialDefinition?.description ?? "");
  const [timed, setTimed] = useState(effect?.expiresAt !== null && effect?.expiresAt !== undefined);
  const [expiresLocal, setExpiresLocal] = useState("");
  const [featured, setFeatured] = useState(initialFeatured);
  const [ambiguousChoices, setAmbiguousChoices] = useState<readonly { expiresAt: string; offset: string }[]>([]);
  const [selectedInstant, setSelectedInstant] = useState("");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");
  const [openedAt] = useState(() => Date.now());
  const filtered = EFFECT_CATALOG.filter(
    (item) =>
      (kind === "all" || item.kind === kind) &&
      item.name.toLocaleLowerCase("de").includes(query.toLocaleLowerCase("de")),
  );

  useEffect(() => {
    if (effect?.expiresAt === null || effect?.expiresAt === undefined) return;
    void expiryToLocalInput(effect.expiresAt, timezone).then(setExpiresLocal).catch(() => {
      setError("Die gespeicherte Ablaufzeit konnte nicht gelesen werden.");
    });
  }, [effect?.expiresAt, timezone]);

  const choose = (definition: EffectDefinition) => {
    setSelected(definition);
    setName(definition.name);
    setDescription(definition.description);
    if (definition.suggestedMinutes !== null) {
      setTimed(true);
      void expiryToLocalInput(
        new Date(openedAt + definition.suggestedMinutes * 60_000).toISOString(),
        timezone,
      ).then(setExpiresLocal);
    } else {
      setTimed(false);
      setExpiresLocal("");
    }
  };

  const commit = async () => {
    if (selected === null && effect === undefined) {
      setError("Bitte zuerst einen Effekt auswählen.");
      return;
    }
    if (name.trim() === "") {
      setError("Der Effekt braucht einen Namen.");
      return;
    }
    if (featured && description.trim() === "") {
      setError("Für die sichtbare Beschreibung fehlt Text.");
      return;
    }
    let expiresAt: string | null = null;
    if (timed) {
      setResolving(true);
      const resolution = await resolveLocalExpiry(expiresLocal, timezone);
      setResolving(false);
      if (resolution.kind === "invalid") {
        setError("Bitte eine gültige absolute Uhrzeit wählen.");
        return;
      }
      if (resolution.kind === "nonexistent") {
        setError(`Diese Uhrzeit existiert in ${timezone} nicht (Zeitumstellung).`);
        return;
      }
      if (resolution.kind === "ambiguous") {
        setAmbiguousChoices(resolution.choices);
        if (!resolution.choices.some((choice) => choice.expiresAt === selectedInstant)) {
          setError("Diese Uhrzeit kommt zweimal vor. Bitte Sommer- oder Winterzeit wählen.");
          return;
        }
        expiresAt = selectedInstant;
      } else {
        expiresAt = resolution.expiresAt;
      }
    }
    const definition = selected ?? initialDefinition;
    onCommit(
      {
        id: effect?.id ?? crypto.randomUUID(),
        catalogId: definition?.id ?? null,
        kind: definition?.kind ?? effect?.kind ?? "buff",
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
        iconId: definition?.iconId ?? effect?.iconId ?? "buff-gestaerkt",
        stacks: effect?.stacks ?? null,
        expiresAt,
        order: effect?.order ?? 0,
      },
      featured,
    );
  };

  return (
    <div className="effect-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label={effect === undefined ? "Effekt hinzufügen" : "Effekt bearbeiten"}
        aria-modal="true"
        className="effect-flyover"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="effect-flyover-header">
          <div><span className="eyebrow">Effekt-Slot</span><h2>{effect === undefined ? "Effekt hinzufügen" : "Effekt bearbeiten"}</h2></div>
          <button className="icon-button" aria-label="Schließen" onClick={onClose} type="button"><X size={18} /></button>
        </header>
        <div className="effect-tabs" role="tablist" aria-label="Effekttyp">
          {(["all", "buff", "debuff"] as const).map((tab) => (
            <button aria-selected={kind === tab} className={kind === tab ? "is-active" : ""} key={tab} onClick={() => setKind(tab)} role="tab" type="button">
              {tab === "all" ? "Alle" : tab === "buff" ? "Buffs" : "Debuffs"}
            </button>
          ))}
        </div>
        <label className="search-field"><Search size={16} /><span className="sr-only">Effekt suchen</span><input placeholder="Effekt suchen …" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="effect-catalog">
          {filtered.map((definition) => (
            <button className={selected?.id === definition.id ? "effect-tile is-selected" : "effect-tile"} key={definition.id} onClick={() => choose(definition)} type="button">
              <img alt="" src={`/assets/effects/${definition.iconId}.webp`} /><span>{definition.name}</span>
            </button>
          ))}
        </div>
        <div className="effect-form">
          <label><span>Name</span><input maxLength={24} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label><span>Beschreibung (optional)</span><textarea maxLength={90} rows={2} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label className="check-row"><input checked={timed} onChange={(event) => setTimed(event.target.checked)} type="checkbox" /><span>Endet zu einer festen Uhrzeit</span></label>
          {timed && <label><span>Endet am · {timezone}</span><input type="datetime-local" value={expiresLocal} onChange={(event) => { setExpiresLocal(event.target.value); setAmbiguousChoices([]); setSelectedInstant(""); setError(""); }} /></label>}
          {ambiguousChoices.length > 0 && <fieldset className="dst-choices"><legend>Zeitumstellung wählen</legend>{ambiguousChoices.map((choice) => <label className="check-row" key={choice.expiresAt}><input checked={selectedInstant === choice.expiresAt} name="dst-instant" type="radio" value={choice.expiresAt} onChange={() => { setSelectedInstant(choice.expiresAt); setError(""); }} /><span>UTC{choice.offset}</span></label>)}</fieldset>}
          <label className="check-row"><input checked={featured} onChange={(event) => setFeatured(event.target.checked)} type="checkbox" /><span>Beschreibung im Overlay anzeigen</span></label>
          {error !== "" && <p className="field-error" role="alert">{error}</p>}
        </div>
        <footer className="effect-actions"><button className="button button--quiet" onClick={onClose} type="button">Abbrechen</button><button className="button button--primary" disabled={resolving} onClick={() => void commit()} type="button">{resolving ? "Prüfe Uhrzeit …" : effect === undefined ? "Hinzufügen" : "Übernehmen"}</button></footer>
      </section>
    </div>
  );
};

const Section = ({
  icon,
  title,
  children,
  defaultOpen = true,
  headerAction,
  isHidden = false,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  headerAction?: ReactNode | undefined;
  isHidden?: boolean;
}) => (
  <details className={`editor-section${isHidden ? " is-hidden" : ""}`} open={defaultOpen}>
    <summary>
      <span className="section-icon">{icon}</span><span className="section-title">{title}{isHidden && <small className="section-hidden-label">ausgeblendet</small>}</span>
      {headerAction !== undefined && <span className="section-header-action" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}>{headerAction}</span>}
      <ChevronDown className="section-chevron" size={17} />
    </summary>
    <div className="editor-section-body">{children}</div>
  </details>
);

const RangeField = ({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (value: number) => void }) => (
  <label className="range-field"><span className="range-label"><span>{label}</span><strong>{value}%</strong></span><input aria-label={label} disabled={disabled} max={100} min={0} type="range" value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>
);

const encodePortrait = async (file: File): Promise<Blob> => {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const target = Math.min(512, Math.max(32, side));
  const canvas = document.createElement("canvas");
  canvas.width = target;
  canvas.height = target;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Bildverarbeitung nicht verfügbar.");
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, target, target);
  bitmap.close();
  for (const quality of [0.9, 0.78, 0.64, 0.5]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    if (blob !== null && blob.size <= 262_144) return blob;
  }
  throw new Error("Das optimierte Portrait ist noch größer als 256 KiB.");
};

const PortraitInput = ({ disabled, upload, onPortrait }: { disabled: boolean; upload?: AdminApi["uploadPortrait"]; onPortrait: (portrait: PortraitRef) => void }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined || upload === undefined) return;
    setBusy(true);
    setError("");
    try { onPortrait(await upload(await encodePortrait(file))); } catch (caught) { setError(caught instanceof Error && caught.message.trim() !== "" ? caught.message : "Portrait konnte nicht verarbeitet werden."); } finally { setBusy(false); event.target.value = ""; }
  };
  return <div className="portrait-input"><label className="button button--quiet"><ImagePlus size={15} /><span>{busy ? "Wird optimiert …" : "Portrait hochladen"}</span><input accept="image/*" disabled={disabled || busy} onChange={(event) => void change(event)} type="file" /></label>{error !== "" && <span className="field-error">{error}</span>}</div>;
};

const isTwitchUserNotFound = (caught: unknown): boolean => {
  if (typeof caught !== "object" || caught === null) return false;
  const error = caught as { code?: unknown; status?: unknown };
  return error.code === "not_found" || error.status === 404;
};

const GuestAdder = ({ disabled, existingTwitchUserIds, lookup, onAddManual, onAddTwitch }: { disabled: boolean; existingTwitchUserIds: readonly string[]; lookup?: AdminApi["lookupTwitchUser"]; onAddManual: (name: string) => void; onAddTwitch: (user: TwitchUser) => void }) => {
  const [value, setValue] = useState("");
  const [pendingUser, setPendingUser] = useState<TwitchUser | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trimmedValue = value.trim();
  const isLogin = trimmedValue !== "" && /^[a-z0-9_]{1,25}$/.test(trimmedValue.toLowerCase());
  const alreadyInGroup = pendingUser !== null && existingTwitchUserIds.includes(pendingUser.id);
  const reset = () => { setValue(""); setPendingUser(null); setNotFound(false); setError(""); };
  const addManual = (name: string) => { onAddManual(name); reset(); };
  const submit = async () => {
    if (disabled || busy || trimmedValue === "") return;
    if (!isLogin) { addManual(trimmedValue); return; }
    setBusy(true); setPendingUser(null); setNotFound(false); setError("");
    try { if (lookup === undefined) throw new Error("Twitch-Lookup nicht verfügbar."); setPendingUser(await lookup(trimmedValue.toLowerCase())); } catch (caught) { if (isTwitchUserNotFound(caught)) setNotFound(true); else setError("Twitch-Gast konnte nicht geladen werden."); } finally { setBusy(false); }
  };
  return (
    <div className="guest-adders">
      <form className="guest-adder-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <input aria-label="Twitch-Login oder Name" disabled={disabled || busy} maxLength={32} placeholder="Twitch-Login oder Name" value={value} onChange={(event) => { setValue(event.target.value); setPendingUser(null); setNotFound(false); setError(""); }} />
        <button className={isLogin ? "button button--twitch" : "button button--primary"} disabled={disabled || busy || trimmedValue === ""} type="submit">{busy && <RotateCw className="spin" size={14} />}{!busy && isLogin && <MessageSquare size={14} />}{busy ? "Wird gesucht …" : isLogin ? "Auf Twitch suchen" : "Als Gast hinzufügen"}</button>
      </form>
      <div aria-live="polite" className="guest-adder-status">
        {pendingUser !== null && <div className="guest-lookup-card"><div className="guest-lookup-identity"><img alt={`Profilbild von ${pendingUser.displayName}`} src={pendingUser.profileImageUrl} /><span><strong>{pendingUser.displayName}</strong><small>@{pendingUser.login}</small></span></div>{alreadyInGroup && <p className="guest-lookup-existing">bereits in der Gruppe</p>}<div className="guest-lookup-actions"><button className="button button--primary" disabled={disabled || alreadyInGroup} onClick={() => { onAddTwitch(pendingUser); reset(); }} type="button">Hinzufügen</button><button className="button button--quiet" disabled={disabled} onClick={reset} type="button">Abbrechen</button></div><button className="button button--quiet" disabled={disabled} onClick={() => addManual(trimmedValue)} type="button">„{trimmedValue}“ als manuellen Gast hinzufügen</button></div>}
        {notFound && <div className="guest-lookup-message"><p>Kein Twitch-Konto mit diesem Login</p><button className="button button--quiet" disabled={disabled} onClick={() => addManual(trimmedValue)} type="button">„{trimmedValue}“ als manuellen Gast hinzufügen</button></div>}
        {error !== "" && <div className="guest-lookup-message"><p className="guest-adder-error" role="alert">{error}</p><button className="button button--quiet" disabled={disabled} onClick={() => addManual(trimmedValue)} type="button">„{trimmedValue}“ als manuellen Gast hinzufügen</button></div>}
      </div>
    </div>
  );
};

export type HudEditorState = {
  committed: ChannelState;
  draft: ChannelStateDraft;
  setDraft: Dispatch<SetStateAction<ChannelStateDraft>>;
  draftBaseRevision: number;
  audit: AuditEntry[];
  auditOpen: boolean;
  newAuditCount: number;
  undoTargets: UndoTarget[];
  online: boolean;
  saving: boolean;
  visibilityBusy: boolean;
  message: string;
  error: string;
  remoteConflict: ChannelState | null;
  overlayToken: BootstrapResponse["capsule"]["overlayToken"];
  dockToken: DockTokenStatus;
  obsSetupOpen: boolean;
  obsLinkCopied: boolean;
  obsUrl: string;
  obsConnectionLabel: string;
  obsConnectionDescription: string;
  obsChipState: "is-live" | "is-idle" | "is-empty";
  obsTokenUnavailable: boolean;
  dirty: boolean;
  locked: boolean;
  preview: ChannelState;
  previewMediaUrls: ReadonlyMap<string, string>;
  effectEditor: ActiveEffect | "new" | null;
  setEffectEditor: (editor: ActiveEffect | "new" | null) => void;
  setObsSetupOpen: Dispatch<SetStateAction<boolean>>;
  setOverlayToken: Dispatch<SetStateAction<BootstrapResponse["capsule"]["overlayToken"]>>;
  setDockToken: Dispatch<SetStateAction<DockTokenStatus>>;
  toggleAudit: () => void;
  updatePlayer: (patch: Partial<ChannelStateDraft["player"]>) => void;
  selectResource: (selection: string) => void;
  save: (replace?: boolean) => Promise<void>;
  savePlacementOnly: () => Promise<void>;
  toggleVisibility: () => Promise<void>;
  undo: (targetRevision: number) => Promise<void>;
  commitEffect: (effect: ActiveEffect, featured: boolean) => void;
  removeEffect: (id: string) => void;
  addManualGuest: (input: string) => void;
  addTwitchGuest: (user: TwitchUser) => void;
  mutateToken: (rotate: boolean) => Promise<void>;
  copyHeaderObsUrl: () => Promise<void>;
  resolveRemoteConflict: () => void;
  uploadPortrait?: AdminApi["uploadPortrait"];
};

export const useHudEditorState = ({
  initialBootstrap,
  api,
  onChallengeUpdate,
}: {
  initialBootstrap: BootstrapResponse;
  api: AdminApi;
  onChallengeUpdate?: (update: ChallengeUpdate) => void;
}): HudEditorState => {
  const [committed, setCommitted] = useState(initialBootstrap.state);
  const [draft, setDraft] = useState(() => toDraft(initialBootstrap.state));
  const [draftBaseRevision, setDraftBaseRevision] = useState(initialBootstrap.state.revision);
  const [audit, setAudit] = useState(initialBootstrap.recentAudit);
  const auditRef = useRef(initialBootstrap.recentAudit);
  const [auditOpen, setAuditOpen] = useState(false);
  const auditOpenRef = useRef(false);
  const [newAuditCount, setNewAuditCount] = useState(0);
  const [undoTargets, setUndoTargets] = useState(initialBootstrap.undoTargets);
  const [online, setOnline] = useState(true);
  const [saving, setSaving] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [remoteConflict, setRemoteConflict] = useState<ChannelState | null>(null);
  const [effectEditor, setEffectEditor] = useState<ActiveEffect | "new" | null>(null);
  const [overlayToken, setOverlayToken] = useState(initialBootstrap.capsule.overlayToken);
  const [dockToken, setDockToken] = useState<DockTokenStatus>(() => initialBootstrap.capsule.dockToken ?? emptyDockTokenStatus());
  const [obsSetupOpen, setObsSetupOpen] = useState(false);
  const [obsLinkCopied, setObsLinkCopied] = useState(false);
  const obsLinkCopiedTimer = useRef<number | null>(null);
  const undoTargetsRevisionRef = useRef(initialBootstrap.state.revision);
  const applyUndoTargets = useCallback((targets: UndoTarget[], revision: number) => {
    if (revision < undoTargetsRevisionRef.current) return;
    undoTargetsRevisionRef.current = revision;
    setUndoTargets(targets);
  }, []);
  const addAuditEntry = useCallback((entry: AuditEntry) => {
    const next = prependAuditEntry(auditRef.current, entry);
    if (next === auditRef.current) return;
    auditRef.current = next;
    setAudit(next);
    if (!auditOpenRef.current) setNewAuditCount((current) => current + 1);
  }, []);
  const toggleAudit = () => {
    const nextOpen = !auditOpenRef.current;
    auditOpenRef.current = nextOpen;
    setAuditOpen(nextOpen);
    if (nextOpen) setNewAuditCount(0);
  };
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(toDraft(committed)), [committed, draft]);
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => () => { if (obsLinkCopiedTimer.current !== null) window.clearTimeout(obsLinkCopiedTimer.current); }, []);
  const preview = toPreview(draft, committed);
  const previewMediaUrls = useMemo(() => {
    const portraits = [draft.player.portrait, draft.pet?.portrait, ...draft.group.map((member) => member.portrait)];
    return new Map(portraits.flatMap((portrait) => portrait?.kind === "uploaded" ? [[portrait.contentHash, `/api/media/${portrait.contentHash}`] as const] : []));
  }, [draft.group, draft.pet?.portrait, draft.player.portrait]);
  const locked = saving || !online;
  const uploadPortrait = api.uploadPortrait?.bind(api);
  const obsUrl = overlayToken.token === null ? "" : buildTokenUrl(window.location.origin, "/overlay/all", overlayToken.token);
  const obsConnectionLabel = overlayToken.connectedSockets > 0 ? `${String(overlayToken.connectedSockets)} verbunden` : overlayToken.exists ? "nicht verbunden" : "kein Link";
  const obsConnectionDescription = `OBS-Verbindung: ${obsConnectionLabel}`;
  const obsChipState = overlayToken.connectedSockets > 0 ? "is-live" : overlayToken.exists ? "is-idle" : "is-empty";
  const obsTokenUnavailable = overlayToken.exists && obsUrl === "";

  useEffect(() => {
    if (api.subscribe === undefined) return;
    const callbacks: Parameters<NonNullable<AdminApi["subscribe"]>>[0] = {
      onState: (state) => {
        if (state.revision > undoTargetsRevisionRef.current) undoTargetsRevisionRef.current = state.revision;
        setCommitted((previous) => {
          if (state.revision <= previous.revision) return previous;
          const contentChanged = JSON.stringify(toDraft(state)) !== JSON.stringify(toDraft(previous));
          if (dirtyRef.current && contentChanged) setRemoteConflict(state);
          else { if (!dirtyRef.current) setDraft(toDraft(state)); setDraftBaseRevision(state.revision); setRemoteConflict(null); }
          return state;
        });
      },
      onOnlineChange: setOnline,
      onOverlayPresence: (connectedSockets) => setOverlayToken((current) => ({ ...current, connectedSockets })),
      onAudit: (entry, targets) => { addAuditEntry(entry); applyUndoTargets(targets, entry.revision); },
      onUndoTargets: setUndoTargets,
    };
    if (onChallengeUpdate !== undefined) callbacks.onChallengeUpdate = onChallengeUpdate;
    return api.subscribe(callbacks);
  }, [addAuditEntry, api, applyUndoTargets, onChallengeUpdate]);

  const pendingLeaseHashes = useMemo(() => {
    const committedHashes = new Set(uploadedHashes(committed));
    return uploadedHashes(draft).filter((hash) => !committedHashes.has(hash));
  }, [committed, draft]);
  const pendingLeaseHashesRef = useRef(pendingLeaseHashes);
  useEffect(() => { pendingLeaseHashesRef.current = pendingLeaseHashes; }, [pendingLeaseHashes]);
  useEffect(() => {
    if (api.renewMediaLeases === undefined) return;
    const renewFn = api.renewMediaLeases.bind(api);
    const timer = window.setInterval(() => { const hashes = pendingLeaseHashesRef.current; if (hashes.length > 0) void renewFn(hashes).catch(() => undefined); }, 30 * 60 * 1_000);
    return () => window.clearInterval(timer);
  }, [api]);

  const updatePlayer = (patch: Partial<ChannelStateDraft["player"]>) => { setDraft((current) => ({ ...current, player: { ...current.player, ...patch } })); setMessage(""); };
  const selectResource = (selection: string) => {
    const preset = RESOURCE_PRESETS.find(({ name }) => name === selection);
    updatePlayer({ resource: preset === undefined ? { ...draft.player.resource, name: "Eigene Ressource" } : { ...draft.player.resource, ...preset } });
  };
  const save = async (replace = false) => {
    if (!dirty || locked) return;
    if (remoteConflict !== null && !replace) { setError("Der OBS-Stand wurde inzwischen geändert. Bitte eine Konfliktaktion wählen."); return; }
    setSaving(true); setError(""); setMessage("");
    try {
      const response = await api.save({ baseRevision: draftBaseRevision, ...(replace && remoteConflict !== null ? { replaceRevision: remoteConflict.revision } : {}), state: structuredClone(draft) });
      setCommitted(response.state); setDraft(toDraft(response.state)); setDraftBaseRevision(response.state.revision); addAuditEntry(response.auditEntry); applyUndoTargets(response.undoTargets, response.state.revision); setRemoteConflict(null); setMessage(`Revision ${String(response.state.revision)} ist jetzt in OBS.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Speichern fehlgeschlagen."); } finally { setSaving(false); }
  };
  // Nur das Placement aus dem committeten Stand veroeffentlichen, keine sonstigen
  // Draft-Aenderungen: state = committed in Draft-Form + neues placement, nicht `draft`.
  // Fehler/Status verwaltet der Aufrufer selbst (Positionen-Button an der Buehne).
  const savePlacementOnly = async (): Promise<void> => {
    if (locked) return;
    const response = await api.save({ baseRevision: committed.revision, state: structuredClone({ ...toDraft(committed), placement: draft.placement }) });
    setCommitted(response.state);
    setDraft((current) => ({ ...current, placement: response.state.placement }));
    setDraftBaseRevision(response.state.revision);
    addAuditEntry(response.auditEntry);
    applyUndoTargets(response.undoTargets, response.state.revision);
  };
  const toggleVisibility = async () => {
    if (visibilityBusy || !online) return;
    if (committed.overlayEnabled && !window.confirm("Overlay in OBS sofort ausblenden? Zuschauer sehen das HUD dann nicht mehr.")) return;
    setVisibilityBusy(true); setError("");
    try { const response = await api.setVisibility(!committed.overlayEnabled); setCommitted(response.state); setDraftBaseRevision((current) => remoteConflict === null ? response.state.revision : current); setRemoteConflict((current) => current === null ? null : response.state); if (response.auditEntry !== null) addAuditEntry(response.auditEntry); applyUndoTargets(response.undoTargets, response.state.revision); setMessage(response.state.overlayEnabled ? "Overlay ist sichtbar." : "Overlay ist vollständig ausgeblendet."); } catch (caught) { setError(caught instanceof Error ? caught.message : "Overlay-Schalter fehlgeschlagen."); } finally { setVisibilityBusy(false); }
  };
  const commitEffect = (effect: ActiveEffect, featured: boolean) => { setDraft((current) => { const exists = current.effects.some((item) => item.id === effect.id); const effects = (exists ? current.effects.map((item) => item.id === effect.id ? effect : item) : [...current.effects, effect]).map((item, order) => ({ ...item, order })); return { ...current, effects, featuredEffectId: featured ? effect.id : current.featuredEffectId === effect.id ? null : current.featuredEffectId }; }); setEffectEditor(null); };
  const removeEffect = (id: string) => setDraft((current) => ({ ...current, effects: current.effects.filter((effect) => effect.id !== id).map((effect, order) => ({ ...effect, order })), featuredEffectId: current.featuredEffectId === id ? null : current.featuredEffectId }));
  const addManualGuest = (input: string) => { const name = input.trim(); if (name === "") return; setDraft((current) => { if (current.group.length >= 5) return current; const member: GroupMember = { id: crypto.randomUUID(), source: "manual", twitchUserId: null, name, portrait: { kind: "initials", text: name.slice(0, 2).toUpperCase() }, hpPercent: 100 }; return { ...current, group: [...current.group, member] }; }); };
  const addTwitchGuest = (user: TwitchUser) => setDraft((current) => { if (current.group.length >= 5 || current.group.some((member) => member.twitchUserId === user.id)) return current; const member: GroupMember = { id: crypto.randomUUID(), source: "twitch", twitchUserId: user.id as GroupMember["twitchUserId"], name: user.displayName, portrait: { kind: "twitch", userId: user.id as Exclude<PortraitRef, { kind: "initials" | "uploaded" | "bundled" }>["userId"], url: user.profileImageUrl }, hpPercent: 100 }; return { ...current, group: [...current.group, member] }; });
  const mutateToken = async (rotate: boolean) => {
    if (api.mutateOverlayToken === undefined) return;
    if (rotate && !window.confirm("Alte OBS-URL sofort ungültig machen und neuen Token erzeugen?")) return;
    try { const result = await mutateObsToken({ api, kind: "overlay", rotate, expectedGeneration: overlayToken.generation }); setOverlayToken((current) => applyOverlayTokenResponse(current, result)); setMessage(rotate ? "Neuer OBS-Link ist bereit; der alte wurde gesperrt." : "OBS-Link wurde erzeugt."); } catch (caught) { setError(caught instanceof Error ? caught.message : "Token-Erzeugung fehlgeschlagen."); }
  };
  const copyHeaderObsUrl = async () => {
    if (obsUrl === "") return;
    try { await copyObsUrl(obsUrl); setError(""); setObsLinkCopied(true); if (obsLinkCopiedTimer.current !== null) window.clearTimeout(obsLinkCopiedTimer.current); obsLinkCopiedTimer.current = window.setTimeout(() => { setObsLinkCopied(false); obsLinkCopiedTimer.current = null; }, 2_000); } catch { setError("OBS-Link konnte nicht kopiert werden."); }
  };
  const undo = async (targetRevision: number) => {
    if (api.undo === undefined || !window.confirm(`Revision ${String(targetRevision)} wiederherstellen?`)) return;
    setSaving(true);
    try { const response = await api.undo(committed.revision, targetRevision); setCommitted(response.state); setDraft(toDraft(response.state)); setDraftBaseRevision(response.state.revision); setRemoteConflict(null); addAuditEntry(response.auditEntry); applyUndoTargets(response.undoTargets, response.state.revision); setMessage(`Revision ${String(targetRevision)} wurde als neue Revision wiederhergestellt.`); } catch (caught) { setError(caught instanceof Error ? caught.message : "Undo fehlgeschlagen."); } finally { setSaving(false); }
  };
  const resolveRemoteConflict = () => {
    if (remoteConflict === null) return;
    setCommitted(remoteConflict);
    setDraft(toDraft(remoteConflict));
    setDraftBaseRevision(remoteConflict.revision);
    setRemoteConflict(null);
    setError("");
  };

  return { committed, draft, setDraft, draftBaseRevision, audit, auditOpen, newAuditCount, undoTargets, online, saving, visibilityBusy, message, error, remoteConflict, overlayToken, dockToken, obsSetupOpen, obsLinkCopied, obsUrl, obsConnectionLabel, obsConnectionDescription, obsChipState, obsTokenUnavailable, dirty, locked, preview, previewMediaUrls, effectEditor, setEffectEditor, setObsSetupOpen, setOverlayToken, setDockToken, toggleAudit, updatePlayer, selectResource, save, savePlacementOnly, toggleVisibility, undo, commitEffect, removeEffect, addManualGuest, addTwitchGuest, mutateToken, copyHeaderObsUrl, resolveRemoteConflict, uploadPortrait };
};

export const HudEditorRail = ({
  initialBootstrap,
  api,
  state,
}: {
  initialBootstrap: BootstrapResponse;
  api: AdminApi;
  state: HudEditorState;
}) => {
  const { draft, locked } = state;
  return (
    <aside className="editor-rail" aria-busy={state.saving}>
      <div className="editor-rail-heading"><div><span className="eyebrow">Moderator-Konsole</span><h2>Live-Steuerung</h2></div><Radio size={19} /></div>
      <div className="editor-scroll">
        <Section icon={<Activity size={16} />} title={draft.player.name}>
          <RangeField disabled={locked} label="Gesundheit" value={draft.player.hpPercent} onChange={(hpPercent) => state.updatePlayer({ hpPercent })} />
          <RangeField disabled={locked} label={draft.player.resource.name} value={draft.player.resource.percent} onChange={(percent) => state.updatePlayer({ resource: { ...draft.player.resource, percent } })} />
        </Section>
        <Section icon={<Sparkles size={16} />} title="Buffs & Debuffs">
          <div className="active-effects">{draft.effects.length === 0 && <p className="empty-copy">Keine aktiven Effekte.</p>}{draft.effects.map((effect) => <div className={`active-effect active-effect--${effect.kind}`} key={effect.id}><button onClick={() => state.setEffectEditor(effect)} type="button"><img alt="" src={`/assets/effects/${effect.iconId}.webp`} /><span><strong>{effect.name}</strong><small>{effect.expiresAt === null ? "Ohne Ablauf" : new Date(effect.expiresAt).toLocaleString("de-DE", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}</small></span></button><button aria-label={`${effect.name} entfernen`} className="icon-button" disabled={locked} onClick={() => state.removeEffect(effect.id)} type="button"><Trash2 size={14} /></button></div>)}</div>
          <button className="button button--quiet button--full" disabled={locked || draft.effects.length >= 8} onClick={() => state.setEffectEditor("new")} type="button"><Plus size={15} /> Effekt hinzufügen <span>{draft.effects.length}/8</span></button>
        </Section>
        {initialBootstrap.capabilities.petEditor && <div className="desktop-only"><Section headerAction={draft.pet === null ? undefined : <button aria-checked={draft.petVisible} aria-label="Pet im Overlay anzeigen" className={`section-switch ${draft.petVisible ? "is-on" : "is-off"}`} disabled={locked} onClick={() => state.setDraft((current) => ({ ...current, petVisible: !current.petVisible }))} role="switch" type="button"><span>{draft.petVisible ? "An" : "Aus"}</span><i aria-hidden="true" /></button>} icon={<PawPrint size={16} />} isHidden={draft.pet !== null && !draft.petVisible} title="Pet">{draft.pet === null ? <button className="button button--quiet button--full" disabled={locked} onClick={() => state.setDraft((current) => ({ ...current, pet: { name: "Begleiter", subtitle: null, portrait: { kind: "initials", text: "BE" }, hpPercent: 100 } }))} type="button"><Plus size={15} /> Pet einrichten</button> : <><RangeField disabled={locked} label={`${draft.pet.name} Gesundheit`} value={draft.pet.hpPercent} onChange={(hpPercent) => state.setDraft((current) => ({ ...current, pet: current.pet === null ? null : { ...current.pet, hpPercent } }))} /><div className="field-grid"><label><span>Name</span><input disabled={locked} maxLength={32} value={draft.pet.name} onChange={(event) => state.setDraft((current) => ({ ...current, pet: current.pet === null ? null : { ...current.pet, name: event.target.value } }))} /></label><label><span>Unterzeile</span><input disabled={locked} maxLength={40} value={draft.pet.subtitle ?? ""} onChange={(event) => state.setDraft((current) => ({ ...current, pet: current.pet === null ? null : { ...current.pet, subtitle: event.target.value === "" ? null : event.target.value } }))} /></label></div><PortraitInput disabled={locked} upload={state.uploadPortrait} onPortrait={(portrait) => state.setDraft((current) => ({ ...current, pet: current.pet === null ? null : { ...current.pet, portrait } }))} /><button className="text-button text-button--danger" disabled={locked} onClick={() => state.setDraft((current) => ({ ...current, pet: null }))} type="button">Pet löschen</button></>}</Section></div>}
        {initialBootstrap.capabilities.groupEditor && <div className="desktop-only"><Section headerAction={draft.group.length === 0 ? undefined : <button aria-checked={draft.groupVisible} aria-label="Gruppe im Overlay anzeigen" className={`section-switch ${draft.groupVisible ? "is-on" : "is-off"}`} disabled={locked} onClick={() => state.setDraft((current) => ({ ...current, groupVisible: !current.groupVisible }))} role="switch" type="button"><span>{draft.groupVisible ? "An" : "Aus"}</span><i aria-hidden="true" /></button>} icon={<Users size={16} />} isHidden={draft.group.length > 0 && !draft.groupVisible} title="Gruppe">{draft.group.length === 0 && <p className="empty-copy">Keine Gäste im Stream.</p>}{draft.group.map((member, index) => <div className="guest-control" key={member.id}><div className="guest-heading"><span>{member.source === "twitch" && <MessageSquare size={13} />}{member.name}</span><button aria-label={`${member.name} entfernen`} className="icon-button" onClick={() => state.setDraft((current) => ({ ...current, group: current.group.filter((item) => item.id !== member.id) }))} type="button"><Trash2 size={14} /></button></div><RangeField disabled={locked} label={`${member.name} Gesundheit`} value={member.hpPercent} onChange={(hpPercent) => state.setDraft((current) => ({ ...current, group: current.group.map((item, itemIndex) => itemIndex === index ? { ...item, hpPercent } : item) }))} /></div>)}{draft.group.length < 5 && <GuestAdder disabled={locked} existingTwitchUserIds={draft.group.flatMap((member) => member.twitchUserId === null ? [] : [member.twitchUserId])} lookup={api.lookupTwitchUser?.bind(api)} onAddManual={state.addManualGuest} onAddTwitch={state.addTwitchGuest} />}</Section></div>}
        <div className="desktop-only"><Section defaultOpen={false} icon={<ChevronDown size={16} />} title="Einrichten"><div className="field-grid"><label><span>Name</span><input disabled={locked} maxLength={32} value={draft.player.name} onChange={(event) => state.updatePlayer({ name: event.target.value })} /></label><label><span>Titel</span><input disabled={locked} maxLength={40} value={draft.player.title ?? ""} onChange={(event) => state.updatePlayer({ title: event.target.value === "" ? null : event.target.value })} /></label><label><span>Level</span><input disabled={locked} max={999} min={1} type="number" value={draft.player.level} onChange={(event) => state.updatePlayer({ level: Number(event.target.value) })} /></label><label><span>Ressource</span><select disabled={locked} value={getResourceSelection(draft.player.resource)} onChange={(event) => state.selectResource(event.target.value)}>{RESOURCE_PRESETS.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}</option>)}<option value={CUSTOM_RESOURCE}>{CUSTOM_RESOURCE}</option></select></label>{getResourceSelection(draft.player.resource) === CUSTOM_RESOURCE && <label><span>Eigene Farbe</span><input disabled={locked} type="color" value={draft.player.resource.color} onChange={(event) => state.updatePlayer({ resource: { ...draft.player.resource, color: event.target.value.toUpperCase() } })} /></label>}</div><PortraitInput disabled={locked} upload={state.uploadPortrait} onPortrait={(portrait) => state.updatePlayer({ portrait })} /><div className="theme-picker" aria-label="Theme">{initialBootstrap.capabilities.enabledThemes.map((theme) => <button aria-pressed={draft.themeId === theme} className={draft.themeId === theme ? "theme-card is-selected" : "theme-card"} disabled={locked} key={theme} onClick={() => state.setDraft((current) => ({ ...current, themeId: theme }))} type="button"><ThemePreviewCard preview={state.preview} previewMediaUrls={state.previewMediaUrls} theme={theme} /><strong>{THEME_LABELS[theme]}</strong>{draft.themeId === theme && <span aria-hidden="true" className="theme-card-check"><Check size={12} /></span>}</button>)}</div><div className="placement-grid"><label><span>X</span><input disabled={locked} max={384} min={0} type="number" value={draft.placement.x} onChange={(event) => state.setDraft((current) => ({ ...current, placement: { ...current.placement, x: Number(event.target.value) } }))} /></label><label><span>Y</span><input disabled={locked} max={216} min={0} type="number" value={draft.placement.y} onChange={(event) => state.setDraft((current) => ({ ...current, placement: { ...current.placement, y: Number(event.target.value) } }))} /></label><label><span>Skalierung</span><select disabled={locked} value={draft.placement.scale} onChange={(event) => state.setDraft((current) => ({ ...current, placement: { ...current.placement, scale: Number(event.target.value) } }))}>{HUD_SCALE_OPTIONS.map((scale) => <option key={scale} value={scale}>{Math.round(scale * 100)}%</option>)}</select></label></div></Section></div>
      </div>
      <footer className="save-dock">
        {state.remoteConflict !== null && <div className="save-conflict" role="alert"><strong>OBS wurde inzwischen geändert</strong><span>Rev. {state.draftBaseRevision} → {state.remoteConflict.revision}. Dein Entwurf ist noch lokal.</span><div><button className="text-button" onClick={state.resolveRemoteConflict} type="button">Serverstand laden</button><button className="text-button text-button--danger" onClick={() => void state.save(true)} type="button">Meinen Entwurf veröffentlichen</button></div></div>}
        <div className="publication-state" aria-live="polite">{state.error !== "" ? <span className="save-error">{state.error}</span> : state.message !== "" ? <span className="save-success">{state.message}</span> : state.dirty ? <span className="save-dirty">Noch nicht an OBS gesendet</span> : <span>Alles veröffentlicht</span>}</div>
        <button className="button button--save" disabled={!state.dirty || locked} onClick={() => void state.save()} type="button" aria-label="Änderungen speichern">{state.saving ? <RotateCw className="spin" size={17} /> : <Save size={17} />}{state.saving ? "Wird gespeichert …" : "Änderungen speichern"}</button>
      </footer>
      {state.effectEditor !== null && <EffectFlyover effect={state.effectEditor === "new" ? undefined : state.effectEditor} initialFeatured={state.effectEditor !== "new" && state.effectEditor.id === draft.featuredEffectId} timezone={initialBootstrap.capsule.timezone} onClose={() => state.setEffectEditor(null)} onCommit={state.commitEffect} />}
    </aside>
  );
};
