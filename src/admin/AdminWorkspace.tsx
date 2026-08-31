import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Eye,
  EyeOff,
  LogOut,
  Plus,
  Radio,
  RotateCw,
  Save,
  Settings2,
  Undo2,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AuditEntry,
  BootstrapResponse,
  DockTokenResponse,
  OverlayTokenResponse,
  SaveRequest,
  SaveResponse,
  UndoTarget,
} from "../shared/contracts/api";
import type { ChallengePlacement, ChallengeStyleId, ChallengeThemeId, ChallengeUpdate } from "../shared/contracts/win-challenges";
import {
  challengeBoardSnapshotSchema,
  type BoardSaveRequest,
  type BoardSaveResponse,
  type ChallengeBoardSnapshot,
  type SettingsSaveRequest,
  type SettingsSaveResponse,
} from "../modules/win-challenges/contracts/schemas";
import { ChallengeBoard, type ChallengeBoardApi } from "../modules/win-challenges/ui/ChallengeBoard";
import { ChallengeLog } from "../modules/win-challenges/ui/ChallengeLog";
import type { AdminWorkspace as AdminWorkspaceId } from "../routing";
import type { ChannelState, PortraitRef } from "../shared/contracts/state";
import { ObsSetupPanel } from "./ui/ObsSetupPanel";
import { HudEditorRail, type HudEditorState, useHudEditorState } from "./ui/HudEditorRail";
import { THEME_LABELS } from "./ui/hudConstants";
import { PreviewPanel } from "./ui/PreviewPanel";
import { createChallengeObsSources } from "./ui/obsSetup";
import { PIXELS_PER_HUD_UNIT, PIXELS_PER_RASTER_UNIT, stagePixelsToRaster } from "./ui/placement";
import "./admin.css";

export type TwitchUser = { id: string; login: string; displayName: string; profileImageUrl: string };

export type AdminApi = {
  save: (request: SaveRequest) => Promise<SaveResponse>;
  setVisibility: (enabled: boolean) => Promise<{ state: ChannelState; auditEntry: BootstrapResponse["recentAudit"][number] | null; undoTargets: BootstrapResponse["undoTargets"]; serverTime: string }>;
  undo?: ((baseRevision: number, targetRevision: number) => Promise<SaveResponse>) | undefined;
  mutateOverlayToken?: ((rotate: boolean, request: { requestId: string; expectedGeneration: number }) => Promise<OverlayTokenResponse>) | undefined;
  mutateDockToken?: ((rotate: boolean, request: { requestId: string; expectedGeneration: number }) => Promise<DockTokenResponse>) | undefined;
  uploadPortrait?: ((blob: Blob) => Promise<PortraitRef>) | undefined;
  renewMediaLeases?: ((contentHashes: string[]) => Promise<void>) | undefined;
  lookupTwitchUser?: ((login: string) => Promise<TwitchUser>) | undefined;
  getChallengeBoard?: (() => Promise<ChallengeBoardSnapshot>) | undefined;
  saveChallengeBoard?: ((request: BoardSaveRequest) => Promise<BoardSaveResponse>) | undefined;
  saveChallengeSettings?: ((request: SettingsSaveRequest) => Promise<SettingsSaveResponse>) | undefined;
  subscribe?: ((callbacks: { onState: (state: ChannelState) => void; onOnlineChange: (online: boolean) => void; onOverlayPresence: (connectedSockets: number) => void; onAudit: (entry: AuditEntry, undoTargets: UndoTarget[]) => void; onUndoTargets: (undoTargets: UndoTarget[]) => void; onChallengeUpdate?: (update: ChallengeUpdate) => void }) => () => void) | undefined;
  logout?: (() => Promise<void>) | undefined;
};

const sameChallengePlacement = (left: ChallengePlacement | null, right: ChallengePlacement): boolean => left !== null && left.x === right.x && left.y === right.y && left.scale === right.scale;

const callPointerCapture = (element: HTMLElement, method: "setPointerCapture" | "releasePointerCapture", pointerId: number): void => {
  const candidate = (element as unknown as Record<string, unknown>)[method];
  if (typeof candidate !== "function") return;
  try {
    Reflect.apply(candidate, element, [pointerId]);
  } catch {
    // lostpointercapture can fire after the browser has already released the pointer.
  }
};

const loadCompositionChallengeStyle = async (styleId: ChallengeStyleId): Promise<void> => {
  const { loadChallengeStyle } = await import("../challenges/style-loader");
  await loadChallengeStyle(styleId);
};

const loadCompositionChallengeTheme = async (themeId: ChallengeThemeId): Promise<void> => {
  const { loadChallengeTheme } = await import("../challenges/theme-loader");
  await loadChallengeTheme(themeId);
};

const ChallengeSettingsPanel = ({ api, online, challengeUpdate, placementDraft, onPlacementDraftChange }: { api: AdminApi; online: boolean; challengeUpdate: ChallengeUpdate | null; placementDraft?: ChallengePlacement | null; onPlacementDraftChange?: (placement: ChallengePlacement) => void }) => {
  const [snapshot, setSnapshot] = useState<ChallengeBoardSnapshot | null>(null);
  const [effectsEnabled, setEffectsEnabled] = useState<boolean | null>(null);
  const [placement, setPlacement] = useState<ChallengePlacement | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const snapshotRef = useRef<ChallengeBoardSnapshot | null>(null);
  const effectsEnabledRef = useRef<boolean | null>(null);
  const placementRef = useRef<ChallengePlacement | null>(null);
  const effectivePlacement = placementDraft ?? placement;
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  useEffect(() => { effectsEnabledRef.current = effectsEnabled; }, [effectsEnabled]);
  useEffect(() => { placementRef.current = effectivePlacement; }, [effectivePlacement]);

  const applyRemoteSnapshot = useCallback((next: ChallengeBoardSnapshot) => {
    const current = snapshotRef.current;
    if (current !== null && next.settingsRevision <= current.settingsRevision) return;
    const localValue = effectsEnabledRef.current;
    const localPlacement = placementRef.current;
    const localDraftChanged = current !== null && ((localValue !== null && localValue !== current.settings.effectsEnabled) || (localPlacement !== null && !sameChallengePlacement(localPlacement, current.settings.placement)));
    const localDraftStillDiffers = localValue !== null && (localValue !== next.settings.effectsEnabled || !sameChallengePlacement(localPlacement, next.settings.placement));
    snapshotRef.current = next;
    setSnapshot(next);
    if (localDraftChanged && localDraftStillDiffers) {
      setError("Einstellungen wurden inzwischen geändert. Der aktuelle Serverstand ist übernommen; dein Entwurf bleibt erhalten.");
      setMessage("");
      return;
    }
    effectsEnabledRef.current = next.settings.effectsEnabled;
    placementRef.current = next.settings.placement;
    setEffectsEnabled(next.settings.effectsEnabled);
    setPlacement(next.settings.placement);
    onPlacementDraftChange?.(next.settings.placement);
    setError("");
    setMessage("");
  }, [onPlacementDraftChange]);

  useEffect(() => {
    if (api.getChallengeBoard === undefined) return;
    let disposed = false;
    void api.getChallengeBoard().then((next) => { if (!disposed) applyRemoteSnapshot(next); }).catch((caught: unknown) => { if (!disposed) setError(caught instanceof Error ? caught.message : "Challenge-Einstellungen konnten nicht geladen werden."); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [api, applyRemoteSnapshot]);
  useEffect(() => {
    if (challengeUpdate === null) return;
    const { themeId: _themeId, ...settings } = challengeUpdate.settings;
    void _themeId;
    applyRemoteSnapshot({ eventSeq: challengeUpdate.eventSeq, boardRevision: challengeUpdate.boardRevision, settingsRevision: challengeUpdate.settingsRevision, settings, challenges: challengeUpdate.challenges });
  }, [applyRemoteSnapshot, challengeUpdate]);
  if (api.getChallengeBoard === undefined || api.saveChallengeSettings === undefined) return null;
  const saveChallengeSettings = api.saveChallengeSettings.bind(api);
  const dirty = snapshot !== null && effectsEnabled !== null && effectivePlacement !== null && (effectsEnabled !== snapshot.settings.effectsEnabled || !sameChallengePlacement(effectivePlacement, snapshot.settings.placement));
  const updatePlacement = (next: ChallengePlacement) => { setPlacement(next); placementRef.current = next; onPlacementDraftChange?.(next); setMessage(""); };
  const save = async () => {
    if (snapshot === null || effectsEnabled === null || effectivePlacement === null || !dirty || saving || !online) return;
    setSaving(true); setError(""); setMessage("");
    try {
      const settings = snapshot.settings;
      const response = await saveChallengeSettings({ baseSettingsRevision: snapshot.settingsRevision, styleId: settings.styleId, themeMode: settings.themeMode, surfaceMode: settings.surfaceMode, headerTitle: settings.headerTitle, effectsEnabled, maxVisible: settings.maxVisible, globalTimerTotalMs: settings.globalTimer?.totalMs ?? null, placement: effectivePlacement });
      snapshotRef.current = response.snapshot; effectsEnabledRef.current = response.snapshot.settings.effectsEnabled; placementRef.current = response.snapshot.settings.placement;
      setSnapshot(response.snapshot); setEffectsEnabled(response.snapshot.settings.effectsEnabled); setPlacement(response.snapshot.settings.placement); onPlacementDraftChange?.(response.snapshot.settings.placement); setMessage("Zeremonie-Einstellung veröffentlicht.");
    } catch (caught) {
      const candidate = typeof caught === "object" && caught !== null ? caught as { code?: unknown; currentSnapshot?: unknown } : {};
      const parsedCurrentSnapshot = candidate.code === "revision_conflict" ? challengeBoardSnapshotSchema.safeParse(candidate.currentSnapshot) : null;
      if (parsedCurrentSnapshot?.success === true) { snapshotRef.current = parsedCurrentSnapshot.data; setSnapshot(parsedCurrentSnapshot.data); setError("Einstellungen wurden inzwischen geändert. Der aktuelle Serverstand ist übernommen; dein Entwurf bleibt erhalten."); } else setError(caught instanceof Error ? caught.message : "Challenge-Einstellungen konnten nicht gespeichert werden.");
    } finally { setSaving(false); }
  };
  const fallbackPlacement = effectivePlacement ?? { x: 300, y: 8, scale: 1 };
  return (
    <section aria-labelledby="challenge-settings-heading" className="challenge-settings-panel">
      <header className="challenge-settings-heading"><div><span className="eyebrow">Publikumssignal</span><h2 id="challenge-settings-heading">Zeremonien</h2><p>Nicht jedes Setup ist ein Quest-Log. Bewegung, Aufblitzen und Ton lassen sich gemeinsam abschalten.</p></div><Volume2 aria-hidden="true" size={20} /></header>
      {error !== "" && <p className="challenge-board-error" role="alert">{error}</p>}
      <label className="challenge-effects-toggle"><input aria-label="Zeremonien und Töne aktiv" checked={effectsEnabled ?? false} disabled={loading || saving || !online || snapshot === null} onChange={(event) => { setEffectsEnabled(event.target.checked); setMessage(""); }} type="checkbox" /><span><strong>Zeremonien und Töne aktiv</strong><small>Der Schalter gilt für alle Challenge-Styles und alle OBS-Quellen.</small></span></label>
      <div className="placement-grid"><label><span>X</span><input disabled={loading || saving || !online || effectivePlacement === null} max={384} min={0} type="number" value={fallbackPlacement.x} onChange={(event) => updatePlacement({ ...fallbackPlacement, x: Number(event.target.value) })} /></label><label><span>Y</span><input disabled={loading || saving || !online || effectivePlacement === null} max={216} min={0} type="number" value={fallbackPlacement.y} onChange={(event) => updatePlacement({ ...fallbackPlacement, y: Number(event.target.value) })} /></label><label><span>Skalierung</span><select disabled={loading || saving || !online || effectivePlacement === null} value={fallbackPlacement.scale} onChange={(event) => updatePlacement({ ...fallbackPlacement, scale: Number(event.target.value) })}>{[0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map((scale) => <option key={scale} value={scale}>{Math.round(scale * 100)}%</option>)}</select></label></div>
      <footer className="challenge-settings-save-bar"><span aria-live="polite" className={dirty ? "save-dirty" : ""}>{loading ? "Einstellungen werden geladen …" : message !== "" ? message : dirty ? "Ungespeicherte Einstellung" : "Einstellung veröffentlicht"}</span><button aria-label="Challenge-Einstellungen speichern" className="button button--save" disabled={!dirty || saving || !online} onClick={() => void save()} type="button"><Save size={17} /> {saving ? "Wird gespeichert …" : "Einstellungen speichern"}</button></footer>
    </section>
  );
};

const channelIdentity = (initialBootstrap: BootstrapResponse) => {
  const channel = initialBootstrap.capsule.channel ?? null;
  if (channel === null) return <div aria-hidden="true" className="channel-identity" />;
  const handle = channel.login.toLowerCase() !== channel.displayName.toLowerCase() ? `@${channel.login}` : null;
  return <div className="channel-identity"><span className="eyebrow">Twitch-Kanal</span><div><strong title={channel.displayName}>{channel.displayName}</strong>{handle !== null && <small>{handle}</small>}</div></div>;
};

const AdminTopbar = ({ initialBootstrap, api, state }: { initialBootstrap: BootstrapResponse; api: AdminApi; state: HudEditorState }) => (
  <header className="admin-topbar">
    <div className="brand-block"><span className="brand-mark"><Activity size={19} /></span><div><strong>{initialBootstrap.capsule.name}</strong><span>Live-Regie</span></div></div>
    <div className="topbar-status">
      <div aria-label={state.obsConnectionDescription} className={`obs-chip ${state.obsChipState}`} role="group" title={state.obsConnectionDescription}>
        <i aria-hidden="true" /><Radio aria-hidden="true" size={14} /><span className="obs-chip-label">OBS</span><span className="obs-chip-connection">{state.obsConnectionLabel}</span>
        {state.obsTokenUnavailable && <span className="sr-only" id="obs-link-unavailable-help">Dieser alte Token ist nicht wiederherstellbar. Bitte einen neuen Token erzeugen.</span>}
        <button aria-label="OBS-Link kopieren" aria-describedby={state.obsTokenUnavailable ? "obs-link-unavailable-help" : undefined} aria-disabled={state.obsTokenUnavailable ? "true" : undefined} className="obs-chip-action" disabled={state.obsUrl === "" && !state.obsTokenUnavailable} onClick={() => void state.copyHeaderObsUrl()} title={state.obsLinkCopied ? "Kopiert" : state.obsTokenUnavailable ? "Dieser alte Token ist nicht wiederherstellbar. Bitte einen neuen Token erzeugen." : state.obsUrl === "" ? "OBS-Link noch nicht erzeugt." : "OBS-Link kopieren"} type="button">{state.obsLinkCopied ? <Check size={14} /> : <Copy size={14} />}</button>
        <button aria-label={state.overlayToken.exists ? "Neuen Token erzeugen" : "OBS-Link erzeugen"} className="obs-chip-action" disabled={!state.online} onClick={() => void state.mutateToken(state.overlayToken.exists)} title={state.overlayToken.exists ? "Neuen Token erzeugen" : "OBS-Link erzeugen"} type="button">{state.overlayToken.exists ? <RotateCw aria-hidden="true" size={14} /> : <Plus aria-hidden="true" size={15} />}</button>
        <button aria-controls="admin-obs-setup" aria-expanded={state.obsSetupOpen} aria-label={state.obsSetupOpen ? "OBS-Einrichtung schließen" : "OBS-Einrichtung öffnen"} className="obs-chip-action" onClick={() => state.setObsSetupOpen((current) => !current)} title={state.obsSetupOpen ? "Einrichtung schließen" : "Einrichtung"} type="button"><Settings2 size={14} /></button>
      </div>
      <span className="revision-pill">Rev. {state.committed.revision}</span>
    </div>
    {channelIdentity(initialBootstrap)}
    <button aria-checked={state.committed.overlayEnabled} aria-label="Overlay aktiv" className={`overlay-switch ${state.committed.overlayEnabled ? "is-on" : "is-off"}`} disabled={state.visibilityBusy || !state.online} onClick={() => void state.toggleVisibility()} role="switch" type="button">{state.committed.overlayEnabled ? <Eye size={17} /> : <EyeOff size={17} />}<span>{state.committed.overlayEnabled ? "Overlay aktiv" : "Overlay aus"}</span><i aria-hidden="true" /></button>
    <div className="editor-identity"><span>{initialBootstrap.editor.displayName}</span><small>Editor</small></div>
    {api.logout !== undefined && <button aria-label="Abmelden" className="icon-button logout-button" onClick={() => { void api.logout?.().then(() => window.location.assign("/login")); }} title="Abmelden" type="button"><LogOut size={16} /></button>}
  </header>
);

const AuditRail = ({ initialBootstrap, state }: { initialBootstrap: BootstrapResponse; state: HudEditorState }) => (
  <aside className={`audit-rail ${state.auditOpen ? "is-open" : "is-collapsed"}`}>
    <button aria-controls="audit-log" aria-expanded={state.auditOpen} className="rail-heading" onClick={state.toggleAudit} type="button"><Clock3 aria-hidden="true" size={15} /><span>Änderungen</span>{state.newAuditCount > 0 && <span aria-label={`${String(state.newAuditCount)} neue Einträge`} className="audit-new-badge">{state.newAuditCount}</span>}<ChevronDown aria-hidden="true" className="audit-chevron" size={15} /></button>
    {state.auditOpen && <div id="audit-log" className="audit-rail-content"><div className="audit-list">{state.audit.length === 0 ? <p className="empty-copy">Noch keine veröffentlichten Änderungen.</p> : state.audit.map((entry) => <article className="audit-entry" key={entry.id}><span className="audit-dot" /><div><strong>{entry.actor.displayName}</strong><p>{entry.summary}</p><time>{new Date(entry.createdAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}</time></div></article>)}</div>{initialBootstrap.capabilities.undo && state.undoTargets.length > 0 && <details className="undo-disclosure"><summary><Undo2 size={14} /> Rückgängig</summary>{state.undoTargets.slice(0, 6).map((target) => <button key={target.revision} onClick={() => void state.undo(target.revision)} type="button">Rev. {target.revision}<span>{target.summary}</span></button>)}</details>}</div>}
  </aside>
);

const AdminTabs = ({ activeTab, onChange }: { activeTab: AdminWorkspaceId; onChange: (tab: AdminWorkspaceId) => void }) => {
  const tabRefs = useRef<Record<AdminWorkspaceId, HTMLButtonElement | null>>({ hud: null, challenges: null });
  const tabs: { id: AdminWorkspaceId; label: string }[] = [{ id: "hud", label: "HUD" }, { id: "challenges", label: "Challenges" }];
  const moveTab = (current: AdminWorkspaceId, direction: -1 | 1) => {
    const index = tabs.findIndex((tab) => tab.id === current);
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    if (next === undefined) return;
    onChange(next.id);
    window.requestAnimationFrame(() => tabRefs.current[next.id]?.focus());
  };
  return (
    <div aria-label="Kompositionsbereiche" className="admin-tabs" role="tablist">
      {tabs.map((tab) => <button aria-controls="admin-composition-panel" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "is-active" : ""} id={`admin-tab-${tab.id}`} key={tab.id} onClick={() => onChange(tab.id)} onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); moveTab(tab.id, 1); }
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); moveTab(tab.id, -1); }
        if (event.key === "Home") { const first = tabs[0]; if (first === undefined) return; event.preventDefault(); onChange(first.id); tabRefs.current[first.id]?.focus(); }
        if (event.key === "End") { const last = tabs[tabs.length - 1]; if (last === undefined) return; event.preventDefault(); onChange(last.id); tabRefs.current[last.id]?.focus(); }
      }} ref={(element) => { tabRefs.current[tab.id] = element; }} role="tab" tabIndex={activeTab === tab.id ? 0 : -1} type="button">{tab.label}</button>)}
    </div>
  );
};

const ModuleVisibilityStrip = ({ hudVisible, challengesVisible, onHudVisibleChange, onChallengesVisibleChange }: { hudVisible: boolean; challengesVisible: boolean; onHudVisibleChange: (visible: boolean) => void; onChallengesVisibleChange: (visible: boolean) => void }) => (
  <section aria-labelledby="module-visibility-heading" className="module-visibility-strip">
    <div className="module-visibility-copy"><strong id="module-visibility-heading">Im Sammel-Overlay zeigen</strong><span>Die Vorschau reagiert sofort. Die OBS-Quelle übernimmt die Auswahl erst mit dem Speichern.</span></div>
    <div className="module-visibility-controls">
      <button aria-checked={hudVisible} aria-label="HUD im Sammel-Overlay anzeigen" className={`module-visibility-toggle ${hudVisible ? "is-on" : "is-off"}`} onClick={() => onHudVisibleChange(!hudVisible)} role="switch" type="button"><span><strong>HUD</strong><small>{hudVisible ? "An" : "Aus"}</small></span><i aria-hidden="true" /></button>
      <button aria-checked={challengesVisible} aria-label="Challenges im Sammel-Overlay anzeigen" className={`module-visibility-toggle ${challengesVisible ? "is-on" : "is-off"}`} onClick={() => onChallengesVisibleChange(!challengesVisible)} role="switch" type="button"><span><strong>Challenges</strong><small>{challengesVisible ? "An" : "Aus"}</small></span><i aria-hidden="true" /></button>
    </div>
  </section>
);

const CompositionWorkspace = ({ initialBootstrap, api, initialTab }: { initialBootstrap: BootstrapResponse; api: AdminApi; initialTab: AdminWorkspaceId }) => {
  const [challengeUpdate, setChallengeUpdate] = useState<ChallengeUpdate | null>(null);
  const [challengePlacementDraft, setChallengePlacementDraft] = useState<ChallengePlacement | null>(null);
  const [previewZoom, setPreviewZoom] = useState(100);
  const [challengeNow, setChallengeNow] = useState(() => Date.now());
  const [dragging, setDragging] = useState<"hud" | "challenges" | null>(null);
  const [activeTab, setActiveTab] = useState<AdminWorkspaceId>(initialTab);
  const [hudVisible, setHudVisible] = useState(true);
  const [challengesVisible, setChallengesVisible] = useState(true);
  const draggingRef = useRef<{ kind: "hud" | "challenges"; pointerId: number } | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const [challengeCss, setChallengeCss] = useState<{ style: string | null; theme: string | null }>({ style: null, theme: null });
  const state = useHudEditorState({ initialBootstrap, api, onChallengeUpdate: setChallengeUpdate });
  const committedThemeId = state.committed.themeId;
  useEffect(() => {
    const timer = window.setInterval(() => setChallengeNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (api.getChallengeBoard === undefined) return;
    let disposed = false;
    void api.getChallengeBoard().then((snapshot) => { if (!disposed) setChallengeUpdate((current) => current ?? { eventSeq: snapshot.eventSeq, boardRevision: snapshot.boardRevision, settingsRevision: snapshot.settingsRevision, settings: { ...snapshot.settings, themeId: committedThemeId }, challenges: snapshot.challenges, event: null }); }).catch(() => undefined);
    return () => { disposed = true; };
  }, [api, committedThemeId]);
  const displayedChallengeUpdate = useMemo(() => challengeUpdate === null ? null : { ...challengeUpdate, settings: { ...challengeUpdate.settings, themeId: committedThemeId } }, [challengeUpdate, committedThemeId]);
  useEffect(() => {
    const styleId = displayedChallengeUpdate?.settings.styleId ?? null;
    const themeMode = displayedChallengeUpdate?.settings.themeMode ?? null;
    const themeId = displayedChallengeUpdate?.settings.themeId ?? null;
    let disposed = false;
    if (styleId === null) return () => { disposed = true; };
    void loadCompositionChallengeStyle(styleId).then(() => { if (!disposed) setChallengeCss((current) => ({ ...current, style: styleId })); }).catch(() => undefined);
    if (themeMode !== "own" && themeId !== null) void loadCompositionChallengeTheme(themeId).then(() => { if (!disposed) setChallengeCss((current) => ({ ...current, theme: themeId })); }).catch(() => undefined);
    return () => { disposed = true; };
  }, [displayedChallengeUpdate]);
  const getPointerStagePoint = (event: React.PointerEvent<HTMLElement>) => {
    const canvas = event.currentTarget.closest(".preview-canvas");
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * 1920,
      y: ((event.clientY - rect.top) / rect.height) * 1080,
    };
  };
  const getPlacementForDrag = (kind: "hud" | "challenges") => kind === "hud"
    ? state.draft.placement
    : challengePlacementDraft ?? displayedChallengeUpdate?.settings.placement ?? { x: 0, y: 0, scale: 1 };
  const pixelsPerUnitFor = (kind: "hud" | "challenges") => kind === "hud" ? PIXELS_PER_HUD_UNIT : PIXELS_PER_RASTER_UNIT;
  const updatePlacementFromPointer = (kind: "hud" | "challenges", event: React.PointerEvent<HTMLElement>) => {
    const pointer = getPointerStagePoint(event);
    if (pointer === null) return;
    const offset = dragOffsetRef.current;
    const pixelsPerUnit = pixelsPerUnitFor(kind);
    const next = stagePixelsToRaster({
      x: pointer.x - (offset?.x ?? 0) * pixelsPerUnit,
      y: pointer.y - (offset?.y ?? 0) * pixelsPerUnit,
    }, pixelsPerUnit);
    if (kind === "hud") state.setDraft((current) => ({ ...current, placement: { ...current.placement, ...next } }));
    else setChallengePlacementDraft((current) => ({ ...(current ?? displayedChallengeUpdate?.settings.placement ?? { x: 0, y: 0, scale: 1 }), ...next }));
  };
  const startDrag = (kind: "hud" | "challenges", event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !state.online) return;
    const pointer = getPointerStagePoint(event);
    if (pointer === null) return;
    const placement = getPlacementForDrag(kind);
    const pixelsPerUnit = pixelsPerUnitFor(kind);
    dragOffsetRef.current = {
      x: pointer.x / pixelsPerUnit - placement.x,
      y: pointer.y / pixelsPerUnit - placement.y,
    };
    draggingRef.current = { kind, pointerId: event.pointerId }; setDragging(kind); callPointerCapture(event.currentTarget, "setPointerCapture", event.pointerId);
  };
  const moveDrag = (kind: "hud" | "challenges", event: React.PointerEvent<HTMLElement>) => { const drag = draggingRef.current; if (drag?.kind === kind && drag.pointerId === event.pointerId) updatePlacementFromPointer(kind, event); };
  const stopDrag = (kind: "hud" | "challenges", event: React.PointerEvent<HTMLElement>) => { const drag = draggingRef.current; if (drag?.kind !== kind || drag.pointerId !== event.pointerId) return; draggingRef.current = null; dragOffsetRef.current = null; setDragging(null); callPointerCapture(event.currentTarget, "releasePointerCapture", event.pointerId); };
  const movePlacementWithKeyboard = (kind: "hud" | "challenges", event: React.KeyboardEvent<HTMLElement>) => {
    if (!state.online) return;
    const step = event.shiftKey ? 10 : 1;
    let delta: { x: number; y: number } | null = null;
    if (event.key === "ArrowLeft") delta = { x: -step, y: 0 };
    if (event.key === "ArrowRight") delta = { x: step, y: 0 };
    if (event.key === "ArrowUp") delta = { x: 0, y: -step };
    if (event.key === "ArrowDown") delta = { x: 0, y: step };
    if (delta === null) return;
    event.preventDefault();
    const pixelsPerUnit = pixelsPerUnitFor(kind);
    const placement = getPlacementForDrag(kind);
    const next = stagePixelsToRaster({ x: (placement.x + delta.x) * pixelsPerUnit, y: (placement.y + delta.y) * pixelsPerUnit }, pixelsPerUnit);
    if (kind === "hud") state.setDraft((current) => ({ ...current, placement: { ...current.placement, ...next } }));
    else setChallengePlacementDraft({ ...placement, ...next });
  };
  const effectiveChallengePlacement = challengePlacementDraft ?? displayedChallengeUpdate?.settings.placement ?? null;
  const compositionHud = state.preview;
  const compositionBoardApi = useMemo<ChallengeBoardApi | null>(() => {
    if (api.getChallengeBoard === undefined || api.saveChallengeBoard === undefined) return null;
    return { load: api.getChallengeBoard.bind(api), save: api.saveChallengeBoard.bind(api) };
  }, [api]);
  const challengeReady = displayedChallengeUpdate !== null && challengeCss.style === displayedChallengeUpdate.settings.styleId && (displayedChallengeUpdate.settings.themeMode === "own" || challengeCss.theme === displayedChallengeUpdate.settings.themeId);
  const challengePreview = !challengesVisible || displayedChallengeUpdate === null || !challengeReady ? null : <ChallengeLog ariaLabel="Challenge-Log verschieben, Pfeiltasten" className={`composition-draggable-module composition-draggable-module--challenge ${dragging === "challenges" ? "is-dragging" : ""}`} onKeyDown={(event) => movePlacementWithKeyboard("challenges", event)} onLostPointerCapture={(event) => stopDrag("challenges", event)} onPointerCancel={(event) => stopDrag("challenges", event)} onPointerDown={(event) => startDrag("challenges", event)} onPointerMove={(event) => moveDrag("challenges", event)} onPointerUp={(event) => stopDrag("challenges", event)} placement={effectiveChallengePlacement ?? displayedChallengeUpdate.settings.placement} rootTag="section" now={challengeNow} update={displayedChallengeUpdate} />;
  return (
    <div className="admin-app admin-app--composition"><AdminTopbar api={api} initialBootstrap={initialBootstrap} state={state} />{!state.online && <div className="offline-banner">Offline – Speichern pausiert; bestehende Werte bleiben sichtbar.</div>}<AuditRail initialBootstrap={initialBootstrap} state={state} /><main className="composition-main">{state.obsSetupOpen && <div id="admin-obs-setup"><ObsSetupPanel api={api} dockToken={state.dockToken} online={state.online} onDockToken={state.setDockToken} onOverlayToken={state.setOverlayToken} overlayToken={state.overlayToken} sources={createChallengeObsSources(window.location.origin, state.overlayToken, state.dockToken)} /></div>}<PreviewPanel hudInteraction={hudVisible ? { ariaLabel: "HUD-Modul verschieben, Pfeiltasten", className: `composition-draggable-module composition-draggable-module--hud ${dragging === "hud" ? "is-dragging" : ""}`, onKeyDown: (event) => movePlacementWithKeyboard("hud", event), onLostPointerCapture: (event) => stopDrag("hud", event), onPointerCancel: (event) => stopDrag("hud", event), onPointerDown: (event) => startDrag("hud", event), onPointerMove: (event) => moveDrag("hud", event), onPointerUp: (event) => stopDrag("hud", event) } : undefined} mediaUrls={state.previewMediaUrls} onZoomChange={setPreviewZoom} previewOverlay={!state.committed.overlayEnabled ? <div className="disabled-veil">Overlay deaktiviert</div> : undefined} showHud={hudVisible} state={compositionHud} themeLabel={THEME_LABELS[state.preview.themeId]} zoom={previewZoom}>{challengePreview}</PreviewPanel><ModuleVisibilityStrip challengesVisible={challengesVisible} hudVisible={hudVisible} onChallengesVisibleChange={setChallengesVisible} onHudVisibleChange={setHudVisible} /></main><aside className="composition-rails"><AdminTabs activeTab={activeTab} onChange={setActiveTab} /><div aria-labelledby={`admin-tab-${activeTab}`} className="composition-tabpanel" id="admin-composition-panel" role="tabpanel">{activeTab === "hud" ? <HudEditorRail api={api} initialBootstrap={initialBootstrap} state={state} /> : <div className="composition-challenge-rail"><ChallengeSettingsPanel api={api} challengeUpdate={displayedChallengeUpdate} online={state.online} onPlacementDraftChange={setChallengePlacementDraft} placementDraft={challengePlacementDraft} />{compositionBoardApi === null ? <section className="challenge-board-shell" role="alert"><div className="challenge-board-empty"><AlertTriangle size={22} /><strong>Challenge-Board ist in dieser Sitzung nicht verfügbar.</strong></div></section> : <ChallengeBoard api={compositionBoardApi} challengeUpdate={displayedChallengeUpdate} online={state.online} />}</div>}</div></aside></div>
  );
};

export const AdminWorkspace = ({ initialBootstrap, api, workspace = "hud" }: { initialBootstrap: BootstrapResponse; api: AdminApi; workspace?: AdminWorkspaceId }) => <CompositionWorkspace api={api} initialBootstrap={initialBootstrap} initialTab={workspace} />;
