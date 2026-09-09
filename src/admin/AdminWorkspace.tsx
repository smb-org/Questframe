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
import type {
  ChallengeDoneOrder,
  ChallengeFontFamily,
  ChallengePlacement,
  ChallengeSettings,
  ChallengeSurfaceOpacity,
  ChallengeStyleId,
  ChallengeThemeId,
  ChallengeUpdate,
  GlobalTimerMode,
  ChallengeOverflowMode,
  ChallengeOverflowTempo,
} from "../shared/contracts/win-challenges";
import {
  challengeBoardSnapshotSchema,
  type BoardSaveRequest,
  type BoardSaveResponse,
  type ChallengeBoardSnapshot,
  type Command,
  type CommandResponse,
  type SettingsSaveRequest,
  type SettingsSaveResponse,
} from "../modules/win-challenges/contracts/schemas";
import { GLOBAL_TIMER_UP_CAP_MS, MAX_VISIBLE_ROWS } from "../modules/win-challenges/contracts/predicates";
import { ChallengeBoard, type ChallengeBoardApi, type ChallengeBoardSaveHandle } from "../modules/win-challenges/ui/ChallengeBoard";
import { ChallengeLog } from "../modules/win-challenges/ui/ChallengeLog";
import { TimerControls } from "../modules/win-challenges/ui/TimerControls";
import { deriveTimerState, type TimerState } from "../modules/win-challenges/domain/timers";
import { displayedMsFor, formatRemaining, remainingFor } from "../modules/win-challenges/ui/timer";
import type { AdminWorkspace as AdminWorkspaceId } from "../routing";
import type { ChannelState, PortraitRef } from "../shared/contracts/state";
import { ObsSetupPanel } from "./ui/ObsSetupPanel";
import { HudEditorRail, type HudEditorState, type ModuleSaveOutcome, useHudEditorState } from "./ui/HudEditorRail";
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
  sendChallengeCommand?: ((command: Command) => Promise<CommandResponse>) | undefined;
  subscribe?: ((callbacks: { onState: (state: ChannelState) => void; onOnlineChange: (online: boolean) => void; onOverlayPresence: (connectedSockets: number) => void; onAudit: (entry: AuditEntry, undoTargets: UndoTarget[]) => void; onUndoTargets: (undoTargets: UndoTarget[]) => void; onChallengeUpdate?: (update: ChallengeUpdate) => void }) => () => void) | undefined;
  logout?: (() => Promise<void>) | undefined;
};

const sameChallengePlacement = (left: ChallengePlacement | null, right: ChallengePlacement): boolean => left !== null && left.x === right.x && left.y === right.y && left.scale === right.scale;

// Griff, den Challenge-Einstellungen und -Board an die globale Speicherleiste
// (GlobalSaveBar) melden: Dirty-Zustand plus ein save(), das den Ausgang direkt
// zurueckgibt statt ueber verzoegerten React-State erkannt zu werden.
type ModuleSaveHandle = { dirty: boolean; save: () => Promise<ModuleSaveOutcome> };

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

type ChallengeSettingsDraft = Pick<ChallengeSettings, "styleId" | "surfaceOpacity" | "headerStyle" | "fontFamily" | "fontScale" | "headerTitle" | "penaltyLabel" | "penaltyText" | "effectsEnabled" | "maxVisible" | "overflowMode" | "overflowTempo" | "numbered" | "doneOrder"> & {
  globalTimerMode: GlobalTimerMode | "off";
  globalTimerTotalMs: number | null;
  globalTimerMinutes: string;
};

type ChallengeSettingsDraftSource = Pick<ChallengeSettings, "styleId" | "surfaceOpacity" | "headerStyle" | "fontFamily" | "fontScale" | "headerTitle" | "penaltyLabel" | "penaltyText" | "effectsEnabled" | "maxVisible" | "overflowMode" | "overflowTempo" | "numbered" | "doneOrder" | "globalTimerMode" | "globalTimer">;

const settingsDraftFrom = (settings: ChallengeSettingsDraftSource): ChallengeSettingsDraft => ({
  styleId: settings.styleId,
  surfaceOpacity: settings.surfaceOpacity,
  headerStyle: settings.headerStyle,
  fontFamily: settings.fontFamily,
  fontScale: settings.fontScale,
  headerTitle: settings.headerTitle,
  penaltyLabel: settings.penaltyLabel,
  penaltyText: settings.penaltyText,
  effectsEnabled: settings.effectsEnabled,
  maxVisible: settings.maxVisible,
  overflowMode: settings.overflowMode,
  overflowTempo: settings.overflowTempo,
  numbered: settings.numbered,
  doneOrder: settings.doneOrder,
  globalTimerMode: settings.globalTimer === null ? "off" : settings.globalTimerMode,
  globalTimerTotalMs: settings.globalTimer?.totalMs ?? null,
  globalTimerMinutes: settings.globalTimer === null ? "" : String(settings.globalTimer.totalMs / 60_000),
});

const sameChallengeSettingsDraft = (left: ChallengeSettingsDraft | null, right: ChallengeSettingsDraft): boolean =>
  left !== null && left.styleId === right.styleId && left.surfaceOpacity === right.surfaceOpacity && left.headerStyle === right.headerStyle && left.fontFamily === right.fontFamily && left.fontScale === right.fontScale && left.headerTitle === right.headerTitle && left.penaltyLabel === right.penaltyLabel && left.penaltyText === right.penaltyText && left.effectsEnabled === right.effectsEnabled && left.maxVisible === right.maxVisible && left.overflowMode === right.overflowMode && left.overflowTempo === right.overflowTempo && left.numbered === right.numbered && left.doneOrder === right.doneOrder && left.globalTimerMode === right.globalTimerMode && left.globalTimerTotalMs === right.globalTimerTotalMs;

const challengeSettingsWithDraft = (settings: ChallengeSettings, draft: ChallengeSettingsDraft | null, themeId: ChallengeThemeId): ChallengeSettings => {
  if (draft === null) return { ...settings, themeId };
  const globalTimerTotalMs = draft.globalTimerMode === "up"
    ? GLOBAL_TIMER_UP_CAP_MS
    : draft.globalTimerTotalMs;
  const timerDurationChanged = globalTimerTotalMs !== (settings.globalTimer?.totalMs ?? null);
  return {
    ...settings,
    themeId,
    styleId: draft.styleId,
    surfaceOpacity: draft.surfaceOpacity,
    headerStyle: draft.headerStyle,
    fontFamily: draft.fontFamily,
    fontScale: draft.fontScale,
    headerTitle: draft.headerTitle,
    penaltyLabel: draft.penaltyLabel,
    penaltyText: draft.penaltyText,
    effectsEnabled: draft.effectsEnabled,
    maxVisible: draft.maxVisible,
    overflowMode: draft.overflowMode,
    overflowTempo: draft.overflowTempo,
    numbered: draft.numbered,
    doneOrder: draft.doneOrder,
    globalTimerMode: draft.globalTimerMode === "off" ? "down" : draft.globalTimerMode,
    globalTimer: draft.globalTimerMode === "off" || globalTimerTotalMs === null
      ? null
      : {
          totalMs: globalTimerTotalMs,
          endsAt: timerDurationChanged ? null : settings.globalTimer?.endsAt ?? null,
          pausedRemainMs: timerDurationChanged ? null : settings.globalTimer?.pausedRemainMs ?? null,
        },
  };
};

const GLOBAL_TIMER_DEFAULT_MS = 60_000;

const liveGlobalTimerStatus = (update: ChallengeUpdate | null, now: number): { state: TimerState; label: string } => {
  const timer = update?.settings.globalTimer;
  if (update === null || timer === null || timer === undefined) return { state: "idle", label: "bereit" };
  const mode = update.settings.globalTimerMode;
  const state = deriveTimerState(timer.endsAt, timer.pausedRemainMs, now);
  const remainingMs = remainingFor(timer.endsAt, timer.pausedRemainMs, state, now);
  const displayedMs = displayedMsFor(mode, timer.totalMs, remainingMs);
  if (state === "expired") {
    return { state, label: mode === "up" ? formatRemaining(displayedMs) : "abgelaufen" };
  }
  if (state === "idle") return { state, label: "bereit" };
  return {
    state,
    label: `${state === "running" ? "läuft" : "pausiert"} · ${formatRemaining(displayedMs)}`,
  };
};

const ChallengeSettingsPanel = ({ api, online, challengeUpdate, placementDraft, onPlacementDraftChange, onDraftChange, onHandleChange }: { api: AdminApi; online: boolean; challengeUpdate: ChallengeUpdate | null; placementDraft?: ChallengePlacement | null; onPlacementDraftChange?: (placement: ChallengePlacement) => void; onDraftChange?: (draft: ChallengeSettingsDraft) => void; onHandleChange?: (handle: ModuleSaveHandle) => void }) => {
  const [snapshot, setSnapshot] = useState<ChallengeBoardSnapshot | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<ChallengeSettingsDraft | null>(null);
  const [placement, setPlacement] = useState<ChallengePlacement | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [timerNow, setTimerNow] = useState(() => Date.now());
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const snapshotRef = useRef<ChallengeBoardSnapshot | null>(null);
  const settingsDraftRef = useRef<ChallengeSettingsDraft | null>(null);
  const placementRef = useRef<ChallengePlacement | null>(null);
  const effectivePlacement = placementDraft ?? placement;
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  useEffect(() => { settingsDraftRef.current = settingsDraft; }, [settingsDraft]);
  useEffect(() => { placementRef.current = effectivePlacement; }, [effectivePlacement]);
  useEffect(() => {
    const interval = window.setInterval(() => setTimerNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const applyRemoteSnapshot = useCallback((next: ChallengeBoardSnapshot) => {
    const current = snapshotRef.current;
    if (current !== null && next.settingsRevision <= current.settingsRevision) return;
    const localValue = settingsDraftRef.current;
    const localPlacement = placementRef.current;
    const localDraftChanged = current !== null && ((localValue !== null && !sameChallengeSettingsDraft(localValue, settingsDraftFrom(current.settings))) || (localPlacement !== null && !sameChallengePlacement(localPlacement, current.settings.placement)));
    const localDraftStillDiffers = localValue !== null && (!sameChallengeSettingsDraft(localValue, settingsDraftFrom(next.settings)) || !sameChallengePlacement(localPlacement, next.settings.placement));
    snapshotRef.current = next;
    setSnapshot(next);
    if (localDraftChanged && localDraftStillDiffers) {
      setError("Einstellungen wurden inzwischen geändert. Der aktuelle Serverstand ist übernommen; dein Entwurf bleibt erhalten.");
      setMessage("");
      return;
    }
    const nextDraft = settingsDraftFrom(next.settings);
    settingsDraftRef.current = nextDraft;
    placementRef.current = next.settings.placement;
    setSettingsDraft(nextDraft);
    setPlacement(next.settings.placement);
    onDraftChange?.(nextDraft);
    onPlacementDraftChange?.(next.settings.placement);
    setError("");
    setMessage("");
  }, [onDraftChange, onPlacementDraftChange]);

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
  const saveChallengeSettings = api.saveChallengeSettings?.bind(api);
  const dirty = snapshot !== null && settingsDraft !== null && effectivePlacement !== null && (!sameChallengeSettingsDraft(settingsDraft, settingsDraftFrom(snapshot.settings)) || !sameChallengePlacement(effectivePlacement, snapshot.settings.placement));
  const updatePlacement = (next: ChallengePlacement) => { setPlacement(next); placementRef.current = next; onPlacementDraftChange?.(next); setMessage(""); };
  const updateSettings = (patch: Partial<ChallengeSettingsDraft>) => {
    setSettingsDraft((current) => {
      if (current === null) return current;
      const next = { ...current, ...patch };
      settingsDraftRef.current = next;
      onDraftChange?.(next);
      setMessage("");
      return next;
    });
  };
  const updateGlobalTimerMode = (value: GlobalTimerMode | "off") => {
    if (value === "off") {
      updateSettings({ globalTimerMode: value, globalTimerTotalMs: null, globalTimerMinutes: "" });
      return;
    }
    const totalMs = value === "up"
      ? GLOBAL_TIMER_UP_CAP_MS
      : settingsDraft?.globalTimerTotalMs ?? GLOBAL_TIMER_DEFAULT_MS;
    updateSettings({
      globalTimerMode: value,
      globalTimerTotalMs: totalMs,
      globalTimerMinutes: settingsDraft?.globalTimerMinutes === "" || settingsDraft?.globalTimerMinutes === undefined
        ? String(totalMs / 60_000)
        : settingsDraft.globalTimerMinutes,
    });
  };
  const updateGlobalTimerMinutes = (minutes: string) => {
    const totalMs = minutes === ""
      ? settingsDraft?.globalTimerMode === "up" ? GLOBAL_TIMER_UP_CAP_MS : null
      : Number(minutes) * 60_000;
    updateSettings({ globalTimerMinutes: minutes, globalTimerTotalMs: totalMs });
  };
  const runGlobalTimerCommand = async (type: "startGlobalTimer" | "pauseGlobalTimer" | "resetGlobalTimer", successMessage: string) => {
    if (api.sendChallengeCommand === undefined || resetting || !online || challengeUpdate?.settings.globalTimer === null || challengeUpdate?.settings.globalTimer === undefined) return;
    setResetting(true);
    setError("");
    setMessage("");
    try {
      await api.sendChallengeCommand({ commandId: crypto.randomUUID(), scope: "global", type });
      setMessage(successMessage);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Globaler Timer konnte nicht geändert werden.");
    } finally {
      setResetting(false);
    }
  };
  const liveStatus = liveGlobalTimerStatus(challengeUpdate, timerNow);
  const save = async (): Promise<ModuleSaveOutcome> => {
    if (saveChallengeSettings === undefined || snapshot === null || settingsDraft === null || effectivePlacement === null || !dirty || saving || !online) return { ok: false, conflict: false, message: "Nicht speicherbar." };
    setSaving(true); setError(""); setMessage("");
    try {
      const settings = snapshot.settings;
      if (settingsDraft.globalTimerMode === "down" && settingsDraft.globalTimerMinutes === "") {
        const messageText = "Für den Modus ‚runterzählen‘ ist eine Dauer erforderlich.";
        setError(messageText);
        return { ok: false, conflict: false, message: messageText };
      }
      const globalTimerTotalMs = settingsDraft.globalTimerMode === "up"
        ? GLOBAL_TIMER_UP_CAP_MS
        : settingsDraft.globalTimerTotalMs;
      const response = await saveChallengeSettings({ baseSettingsRevision: snapshot.settingsRevision, styleId: settingsDraft.styleId, themeMode: settings.themeMode, surfaceOpacity: settingsDraft.surfaceOpacity, headerStyle: settingsDraft.headerStyle, fontFamily: settingsDraft.fontFamily, fontScale: settingsDraft.fontScale, headerTitle: settingsDraft.headerTitle, penaltyLabel: settingsDraft.penaltyLabel, penaltyText: settingsDraft.penaltyText, effectsEnabled: settingsDraft.effectsEnabled, maxVisible: settingsDraft.maxVisible, overflowMode: settingsDraft.overflowMode, overflowTempo: settingsDraft.overflowTempo, numbered: settingsDraft.numbered, doneOrder: settingsDraft.doneOrder, globalTimerMode: settingsDraft.globalTimerMode === "off" ? "down" : settingsDraft.globalTimerMode, globalTimerTotalMs, placement: effectivePlacement });
      // Derselbe Revisions-Guard wie in applyRemoteSnapshot: waehrend unsere Antwort
      // unterwegs war, kann per Socket schon eine neuere Revision eingetroffen sein
      // (zweiter Editor). Eine verspaetete eigene Antwort darf diesen neueren lokalen
      // Stand nicht zurueckdrehen, sonst laeuft der naechste Save in einen falschen Konflikt.
      if (snapshotRef.current === null || response.snapshot.settingsRevision > snapshotRef.current.settingsRevision) {
        const nextDraft = settingsDraftFrom(response.snapshot.settings);
        snapshotRef.current = response.snapshot; settingsDraftRef.current = nextDraft; placementRef.current = response.snapshot.settings.placement;
        setSnapshot(response.snapshot); setSettingsDraft(nextDraft); setPlacement(response.snapshot.settings.placement); onDraftChange?.(nextDraft); onPlacementDraftChange?.(response.snapshot.settings.placement);
      }
      setMessage("Einstellung veröffentlicht.");
      return { ok: true, conflict: false };
    } catch (caught) {
      const candidate = typeof caught === "object" && caught !== null ? caught as { code?: unknown; currentSnapshot?: unknown } : {};
      const parsedCurrentSnapshot = candidate.code === "revision_conflict" ? challengeBoardSnapshotSchema.safeParse(candidate.currentSnapshot) : null;
      if (parsedCurrentSnapshot?.success === true) {
        snapshotRef.current = parsedCurrentSnapshot.data; setSnapshot(parsedCurrentSnapshot.data);
        const conflictMessage = "Einstellungen wurden inzwischen geändert. Der aktuelle Serverstand ist übernommen; dein Entwurf bleibt erhalten.";
        setError(conflictMessage);
        return { ok: false, conflict: true, message: conflictMessage };
      }
      const messageText = caught instanceof Error ? caught.message : "Challenge-Einstellungen konnten nicht gespeichert werden.";
      setError(messageText);
      return { ok: false, conflict: false, message: messageText };
    } finally { setSaving(false); }
  };
  // Griff fuer die globale Speicherleiste, siehe ChallengeBoard.tsx fuer denselben Ref-Kniff.
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; });
  useEffect(() => {
    onHandleChange?.({ dirty, save: () => saveRef.current() });
  }, [dirty, onHandleChange]);
  if (api.getChallengeBoard === undefined || api.saveChallengeSettings === undefined) return null;
  const fallbackPlacement = effectivePlacement ?? { x: 300, y: 8, scale: 1 };
  const disabled = loading || saving || !online || snapshot === null;
  return (
    <section aria-labelledby="challenge-settings-heading" className="challenge-settings-panel">
      <header className="challenge-settings-heading"><h2 id="challenge-settings-heading">Darstellung</h2></header>
      {error !== "" && <p className="challenge-board-error" role="alert">{error}</p>}
      {settingsDraft !== null && <>
        <div className="settings-grid challenge-settings-quick" aria-label="Schnelleinstellungen">
          <label><span>Hintergrund</span><select aria-label="Hintergrund" disabled={disabled} value={settingsDraft.surfaceOpacity} onChange={(event) => updateSettings({ surfaceOpacity: Number(event.target.value) as ChallengeSurfaceOpacity })}>{([100, 75, 50, 25, 0] as const).map((value) => <option key={value} value={value}>{value === 100 ? "deckend (100 %)" : value === 0 ? "0 % · fette Schrift mit Schatten" : value === 25 ? "25 % · fette Schrift mit Schatten" : `${String(value)} %`}</option>)}</select></label>
          <label><span>Sichtbare Einträge</span><select aria-label="Sichtbare Einträge" disabled={disabled} value={settingsDraft.maxVisible} onChange={(event) => updateSettings({ maxVisible: Number(event.target.value) })}>{Array.from({ length: MAX_VISIBLE_ROWS - 2 }, (_, index) => index + 3).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label><span>Textgröße</span><select aria-label="Textgröße" disabled={disabled} value={settingsDraft.fontScale} onChange={(event) => updateSettings({ fontScale: Number(event.target.value) })}>{Array.from({ length: 26 }, (_, index) => Number((0.75 + index * 0.05).toFixed(2))).map((value) => <option key={value} value={value}>{Math.round(value * 100)} %</option>)}</select></label>
          <label><span>Quellengröße</span><select aria-label="Quellengröße" disabled={loading || saving || !online || effectivePlacement === null} value={fallbackPlacement.scale} onChange={(event) => updatePlacement({ ...fallbackPlacement, scale: Number(event.target.value) })}>{[0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map((scale) => <option key={scale} value={scale}>{Math.round(scale * 100)}%</option>)}</select></label>
          <label><span>X</span><input aria-label="X" disabled={loading || saving || !online || effectivePlacement === null} max={384} min={0} type="number" value={fallbackPlacement.x} onChange={(event) => updatePlacement({ ...fallbackPlacement, x: Number(event.target.value) })} /></label>
          <label><span>Y</span><input aria-label="Y" disabled={loading || saving || !online || effectivePlacement === null} max={216} min={0} type="number" value={fallbackPlacement.y} onChange={(event) => updatePlacement({ ...fallbackPlacement, y: Number(event.target.value) })} /></label>
        </div>

            <fieldset>
              <legend>Aussehen</legend>
              <div className="settings-grid">
                <label><span>Listenart</span><select aria-label="Listenart" disabled={disabled} value={settingsDraft.styleId} onChange={(event) => updateSettings({ styleId: event.target.value as ChallengeStyleId })}><option value="plain-list">Liste</option><option value="plain-bullets">Aufzählung</option><option value="quest-log">Quest-Log</option></select></label>
                <label><span>Schriftart</span><select aria-label="Schriftart" disabled={disabled} value={settingsDraft.fontFamily} onChange={(event) => updateSettings({ fontFamily: event.target.value as ChallengeFontFamily })}><option value="theme">Wie Theme</option><option value="atkinson">Atkinson Hyperlegible</option><option value="serif">Serif</option><option value="sans">Sans</option><option value="mono">Mono</option></select></label>
                <div className="challenge-checkbox-pair">
                  <label className="challenge-numbered-toggle"><input aria-label="Nummerierung" checked={settingsDraft.numbered} disabled={disabled} onChange={(event) => updateSettings({ numbered: event.target.checked })} type="checkbox" /><span>Nummerierung</span></label>
                  <label className="challenge-numbered-toggle"><input aria-label="Animationen und Töne" checked={settingsDraft.effectsEnabled} disabled={disabled} onChange={(event) => updateSettings({ effectsEnabled: event.target.checked })} title="Der Schalter gilt für alle Styles und alle OBS-Quellen." type="checkbox" /><span>Animationen und Töne</span></label>
                </div>
              </div>
            </fieldset>
            <fieldset>
              <legend>Kopf- und Fußzeile</legend>
              <div className="settings-grid">
                <label><span>Titel</span><input aria-label="Titel" maxLength={24} disabled={disabled} type="text" value={settingsDraft.headerTitle} onChange={(event) => updateSettings({ headerTitle: event.target.value })} /></label>
                <label><span>Stil</span><select aria-label="Stil" disabled={disabled} value={settingsDraft.headerStyle} onChange={(event) => updateSettings({ headerStyle: event.target.value as ChallengeSettingsDraft["headerStyle"] })}><option value="default">Schlicht</option><option value="inverted">Akzentband</option></select></label>
                <label><span>Strafen-Titel</span><input aria-label="Strafen-Titel" maxLength={24} disabled={disabled} placeholder="leer = ohne Beschriftung" type="text" value={settingsDraft.penaltyLabel} onChange={(event) => updateSettings({ penaltyLabel: event.target.value })} /></label>
                <label><span>Strafe</span><input aria-label="Strafe" maxLength={80} disabled={disabled} placeholder="leer = keine Fußzeile" type="text" value={settingsDraft.penaltyText} onChange={(event) => updateSettings({ penaltyText: event.target.value })} /></label>
              </div>
            </fieldset>
            <fieldset>
              <legend>Einträge</legend>
              <div className="settings-grid">
                <label><span>Bei mehr als {settingsDraft.maxVisible} Einträgen</span><select aria-label={`Bei mehr als ${String(settingsDraft.maxVisible)} Einträgen`} disabled={disabled} value={settingsDraft.overflowMode} onChange={(event) => updateSettings({ overflowMode: event.target.value as ChallengeOverflowMode })}><option value="cut">Rest abschneiden</option><option value="page">seitenweise blättern</option><option value="scroll">durchlaufen lassen</option></select></label>
                <label><span>Wechseltempo</span><select aria-label="Wechseltempo" disabled={disabled || settingsDraft.overflowMode === "cut"} value={settingsDraft.overflowTempo} onChange={(event) => updateSettings({ overflowTempo: event.target.value as ChallengeOverflowTempo })}><option value="slow">langsam</option><option value="medium">mittel</option><option value="fast">schnell</option></select>{settingsDraft.overflowMode === "cut" && <small className="field-help">nur bei Blättern/Durchlaufen</small>}</label>
                <label><span>Erledigte Einträge</span><select aria-label="Erledigte Einträge" disabled={disabled} value={settingsDraft.doneOrder} onChange={(event) => updateSettings({ doneOrder: event.target.value as ChallengeDoneOrder })}><option value="end">ans Ende rücken</option><option value="keep">an ihrem Platz lassen</option></select>{settingsDraft.overflowMode === "cut" && settingsDraft.doneOrder === "end" && <small className="field-help">Bei ‚Rest abschneiden‘ fallen sie hinten raus.</small>}</label>
              </div>
            </fieldset>
            <fieldset>
              <legend>Timer</legend>
              <div className="settings-grid">
                <label><span>Modus</span><select aria-label="Modus" disabled={disabled} value={settingsDraft.globalTimerMode} onChange={(event) => updateGlobalTimerMode(event.target.value as GlobalTimerMode | "off")}><option value="off">aus</option><option value="down">runterzählen</option><option value="up">hochzählen</option></select></label>
                <label><span>Dauer</span><span className="challenge-timer-input"><input aria-label="Dauer" disabled={disabled || settingsDraft.globalTimerMode !== "down"} max={GLOBAL_TIMER_UP_CAP_MS / 60_000} min={1} required={settingsDraft.globalTimerMode === "down"} step={1} type="number" value={settingsDraft.globalTimerMinutes} onChange={(event) => updateGlobalTimerMinutes(event.target.value)} /><small>Minuten</small></span>{settingsDraft.globalTimerMode !== "down" && <small className="field-help">nur beim Runterzählen</small>}</label>
                <div className="challenge-timer-actions">
                  <span className="challenge-settings-cell-label">Bedienung</span>
                  <div className="challenge-timer-actions-row">
                    <small className={`challenge-timer-status challenge-timer-status--${liveStatus.state}`}>{liveStatus.label}</small>
                    <TimerControls
                      disabled={disabled || resetting || api.sendChallengeCommand === undefined || challengeUpdate?.settings.globalTimer === null || challengeUpdate?.settings.globalTimer === undefined}
                      labelPrefix="Globaler Timer"
                      onReset={() => void runGlobalTimerCommand("resetGlobalTimer", "Globaler Timer zurückgesetzt.")}
                      onToggle={() => void runGlobalTimerCommand(liveStatus.state === "running" ? "pauseGlobalTimer" : "startGlobalTimer", liveStatus.state === "running" ? "Globaler Timer pausiert." : "Globaler Timer gestartet.")}
                      state={liveStatus.state}
                    />
                  </div>
                </div>
              </div>
            </fieldset>

      </>}
      {/* Kein modul-eigener Speichern-Button mehr: die globale Speicherleiste ist die
          einzige Speicher-Aktion. Status/Dirty-Anzeige bleibt fuer Sichtbarkeit. */}
      <footer className="challenge-settings-save-bar"><span aria-live="polite" className={dirty ? "save-dirty" : ""}>{loading ? "Einstellungen werden geladen …" : message !== "" ? message : dirty ? "Ungespeicherte Einstellung" : "Einstellung veröffentlicht"}</span><span>Die Vorschau links zeigt den Entwurf. Position auch per Ziehen.</span></footer>
    </section>
  );
};

const channelIdentity = (initialBootstrap: BootstrapResponse) => {
  const channel = initialBootstrap.capsule.channel ?? null;
  if (channel === null) return <div aria-hidden="true" className="channel-identity" />;
  const handle = channel.login.toLowerCase() !== channel.displayName.toLowerCase() ? `@${channel.login}` : null;
  return <div className="channel-identity"><span className="eyebrow">Twitch-Kanal</span><div><strong title={channel.displayName}>{channel.displayName}</strong>{handle !== null && <small>{handle}</small>}</div></div>;
};

const AdminTopbar = ({ initialBootstrap, api, state, obsSetupTriggerRef }: { initialBootstrap: BootstrapResponse; api: AdminApi; state: HudEditorState; obsSetupTriggerRef: React.RefObject<HTMLButtonElement | null> }) => (
  <header className="admin-topbar">
    <div className="brand-block"><span className="brand-mark"><Activity size={19} /></span><div><strong>{initialBootstrap.capsule.name}</strong><span>Live-Regie</span></div></div>
    <div className="topbar-status">
      <div aria-label={state.obsConnectionDescription} className={`obs-chip ${state.obsChipState}`} role="group" title={state.obsConnectionDescription}>
        <i aria-hidden="true" /><Radio aria-hidden="true" size={14} /><span className="obs-chip-label">OBS</span><span className="obs-chip-connection">{state.obsConnectionLabel}</span>
        {state.obsTokenUnavailable && <span className="sr-only" id="obs-link-unavailable-help">Dieser alte Token ist nicht wiederherstellbar. Bitte einen neuen Token erzeugen.</span>}
        <button aria-label="OBS-Link kopieren" aria-describedby={state.obsTokenUnavailable ? "obs-link-unavailable-help" : undefined} aria-disabled={state.obsTokenUnavailable ? "true" : undefined} className="obs-chip-action" disabled={state.obsUrl === "" && !state.obsTokenUnavailable} onClick={() => void state.copyHeaderObsUrl()} title={state.obsLinkCopied ? "Kopiert" : state.obsTokenUnavailable ? "Dieser alte Token ist nicht wiederherstellbar. Bitte einen neuen Token erzeugen." : state.obsUrl === "" ? "OBS-Link noch nicht erzeugt." : "OBS-Link kopieren"} type="button">{state.obsLinkCopied ? <Check size={14} /> : <Copy size={14} />}</button>
        <button aria-label={state.overlayToken.exists ? "Neuen Token erzeugen" : "OBS-Link erzeugen"} className="obs-chip-action" disabled={!state.online} onClick={() => void state.mutateToken(state.overlayToken.exists)} title={state.overlayToken.exists ? "Neuen Token erzeugen" : "OBS-Link erzeugen"} type="button">{state.overlayToken.exists ? <RotateCw aria-hidden="true" size={14} /> : <Plus aria-hidden="true" size={15} />}</button>
        <button aria-controls="admin-obs-setup" aria-expanded={state.obsSetupOpen} aria-label={state.obsSetupOpen ? "OBS-Einrichtung schließen" : "OBS-Einrichtung öffnen"} className="obs-chip-action" onClick={() => state.setObsSetupOpen((current) => !current)} ref={obsSetupTriggerRef} title={state.obsSetupOpen ? "Einrichtung schließen" : "Einrichtung"} type="button"><Settings2 size={14} /></button>
      </div>
      <span className="revision-pill">Rev. {state.committed.revision}</span>
    </div>
    {channelIdentity(initialBootstrap)}
    <button aria-checked={state.committed.overlayEnabled} aria-label="Overlay aktiv" className={`overlay-switch ${state.committed.overlayEnabled ? "is-on" : "is-off"}`} disabled={state.visibilityBusy || !state.online} onClick={() => void state.toggleVisibility()} role="switch" type="button">{state.committed.overlayEnabled ? <Eye size={17} /> : <EyeOff size={17} />}<span>{state.committed.overlayEnabled ? "Overlay aktiv" : "Overlay aus"}</span><i aria-hidden="true" /></button>
    <div className="editor-identity"><span>{initialBootstrap.editor.displayName}</span><small>Editor</small></div>
    {api.logout !== undefined && <button aria-label="Abmelden" className="icon-button logout-button" onClick={() => { void api.logout?.().then(() => window.location.assign("/login")); }} title="Abmelden" type="button"><LogOut size={16} /></button>}
  </header>
);

/* Natives <dialog> statt Eigenbau-Overlay: showModal()/close() übernehmen Fokusfalle
   und Top-Layer-Darstellung, sodass die Buehne nie verschoben wird. jsdom (Tests) kennt
   showModal/close nicht, darum die Feature-Detection-Fallbacks auf das open-Attribut. */
const ObsSetupDialog = ({ api, state, triggerRef }: { api: AdminApi; state: HudEditorState; triggerRef: React.RefObject<HTMLButtonElement | null> }) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const wasOpenRef = useRef(false);
  const close = () => state.setObsSetupOpen(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (state.obsSetupOpen) {
      if (typeof dialog.showModal === "function") { if (!dialog.open) dialog.showModal(); } else dialog.setAttribute("open", "");
      dialog.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]")?.focus();
    } else if (wasOpenRef.current) {
      if (typeof dialog.close === "function") { if (dialog.open) dialog.close(); } else dialog.removeAttribute("open");
      triggerRef.current?.focus();
    }
    wasOpenRef.current = state.obsSetupOpen;
  }, [state.obsSetupOpen, triggerRef]);
  return (
    <dialog
      aria-labelledby="obs-setup-heading"
      className="obs-setup-dialog"
      id="admin-obs-setup"
      onClick={(event) => { if (event.target === dialogRef.current) close(); }}
      onClose={close}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }}
      ref={dialogRef}
    >
      <ObsSetupPanel api={api} dockToken={state.dockToken} online={state.online} onDockToken={state.setDockToken} onOverlayToken={state.setOverlayToken} overlayToken={state.overlayToken} sources={createChallengeObsSources(window.location.origin, state.overlayToken, state.dockToken)} />
    </dialog>
  );
};

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
      {tabs.map((tab) => <button aria-controls={`admin-composition-panel-${tab.id}`} aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "is-active" : ""} id={`admin-tab-${tab.id}`} key={tab.id} onClick={() => onChange(tab.id)} onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); moveTab(tab.id, 1); }
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); moveTab(tab.id, -1); }
        if (event.key === "Home") { const first = tabs[0]; if (first === undefined) return; event.preventDefault(); onChange(first.id); tabRefs.current[first.id]?.focus(); }
        if (event.key === "End") { const last = tabs[tabs.length - 1]; if (last === undefined) return; event.preventDefault(); onChange(last.id); tabRefs.current[last.id]?.focus(); }
      }} ref={(element) => { tabRefs.current[tab.id] = element; }} role="tab" tabIndex={activeTab === tab.id ? 0 : -1} type="button">{tab.label}</button>)}
    </div>
  );
};

/* Kompakt fuer die Vorschau-Kopfzeile (links vom Zoom-Regler): die Erklaerung aus dem
   frueheren Strip-Block steckt jetzt im title-Tooltip statt als eigener Absatz. */
const ModuleVisibilityControls = ({ state }: { state: HudEditorState }) => (
  <div aria-label="Im Sammel-Overlay zeigen" className="preview-module-toggles" role="group" title="Die Vorschau reagiert sofort. Die OBS-Quelle übernimmt die Auswahl erst mit dem Speichern.">
    <button aria-checked={state.draft.compositeHudVisible} aria-label="HUD im Sammel-Overlay anzeigen" className={`preview-module-toggle ${state.draft.compositeHudVisible ? "is-on" : "is-off"}`} disabled={state.locked} onClick={() => state.setDraft((current) => ({ ...current, compositeHudVisible: !current.compositeHudVisible }))} role="switch" type="button"><span>HUD</span><i aria-hidden="true" /></button>
    <button aria-checked={state.draft.compositeChallengesVisible} aria-label="Challenges im Sammel-Overlay anzeigen" className={`preview-module-toggle ${state.draft.compositeChallengesVisible ? "is-on" : "is-off"}`} disabled={state.locked} onClick={() => state.setDraft((current) => ({ ...current, compositeChallengesVisible: !current.compositeChallengesVisible }))} role="switch" type="button"><span>Challenges</span><i aria-hidden="true" /></button>
  </div>
);

/* Der Sekunden-Tick fürs Challenge-Log lebt nur hier, nicht auf Workspace-Ebene:
   so re-rendert er ausschließlich diesen Preview-Zweig statt die gesamte Admin-App,
   und läuft nur, solange das Challenge-Log tatsächlich im Preview sichtbar ist. */
const ChallengeLogPreview = (props: Omit<React.ComponentProps<typeof ChallengeLog>, "now">) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <ChallengeLog {...props} now={now} />;
};

/* Konflikt-Dialog und Fehleranzeige auf Workspace-Ebene: die Rail (HudEditorRail) zeigt
   ihre eigene Anzeige nur im HUD-Tab, deshalb bräuchte ein Konflikt aus einem parallelen
   Save sonst keine Auflösung, solange der Challenges-Tab aktiv ist. Wird nur gerendert,
   während der Challenges-Tab aktiv ist – im HUD-Tab übernimmt die Rail dieselbe Optik,
   keine Doppel-Anzeige. Kein Speichern-Button mehr: die globale Speicherleiste ist die
   einzige Speicher-Aktion, hier bleiben nur Konfliktaufloesung und Status. */
const CompositionSaveDock = ({ state }: { state: HudEditorState }) => (
  <footer className="save-dock composition-save-dock">
    {state.remoteConflict !== null && <div className="save-conflict" role="alert"><strong>OBS wurde inzwischen geändert</strong><span>Rev. {state.draftBaseRevision} → {state.remoteConflict.revision}. Dein Entwurf ist noch lokal.</span><div><button className="text-button" onClick={state.resolveRemoteConflict} type="button">Serverstand laden</button><button className="text-button text-button--danger" onClick={() => void state.save(true)} type="button">Meinen Entwurf veröffentlichen</button></div></div>}
    <div className="publication-state" aria-live="polite">{state.error !== "" ? <span className="save-error">{state.error}</span> : state.message !== "" ? <span className="save-success">{state.message}</span> : state.dirty ? <span className="save-dirty">Noch nicht an OBS gesendet</span> : <span>Alles veröffentlicht</span>}</div>
  </footer>
);

// Ein Modul fuer die globale Speicherleiste: dirty-Flag und save()-Griff kommen entweder
// direkt aus useHudEditorState (HUD) oder aus einem registrierten ModuleSaveHandle
// (Challenge-Einstellungen, Challenge-Board).
type SaveAllModule = { key: string; label: string; tab: AdminWorkspaceId; dirty: boolean; save: () => Promise<ModuleSaveOutcome> };

/* Die eine schwebende Speicherleiste fuer die ganze Ansicht (statt HUD-Draft,
   Challenge-Einstellungen, Challenge-Board und vormals dem Positions-Button je einzeln
   zu suchen). Speichert SEQUENZIELL in der uebergebenen Reihenfolge – kein atomares
   Speichern moeglich (drei Endpunkte/Revisionen). Bricht bei der ersten fehlgeschlagenen
   oder blockierten (Konflikt-)Speicherung ab: bereits gespeicherte Module bleiben
   gespeichert (Teilerfolg), das betroffene Modul bleibt dirty, die Leiste bleibt stehen
   und der Tab mit der modul-eigenen Konflikt-/Fehler-UI wird aktiviert. */
const GlobalSaveBar = ({ modules, online, onNavigate }: { modules: SaveAllModule[]; online: boolean; onNavigate: (tab: AdminWorkspaceId) => void }) => {
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ key: string; label: string; message: string } | null>(null);
  const dirtyModules = modules.filter((module) => module.dirty);
  // Ein alter Fehler verschwindet automatisch, sobald sein Modul nicht mehr dirty ist
  // (z.B. weil es lokal ueber die eigene Save-Bar aufgeloest wurde) – ohne Extra-Effekt.
  const displayedFailure = failure !== null && dirtyModules.some((module) => module.key === failure.key) ? failure : null;
  if (dirtyModules.length === 0) return null;
  const saveAll = async () => {
    if (saving || !online) return;
    setSaving(true); setFailure(null);
    for (const module of dirtyModules) {
      const outcome = await module.save();
      if (!outcome.ok) {
        onNavigate(module.tab);
        setFailure({ key: module.key, label: module.label, message: outcome.message ?? "Speichern fehlgeschlagen." });
        setSaving(false);
        return;
      }
    }
    setSaving(false);
  };
  return (
    <footer className="global-save-bar" role="status">
      <div className="global-save-bar-copy">
        <strong>Ungespeicherte Änderungen</strong>
        <span aria-live="polite">
          {!online ? <span className="save-dirty">Offline – Speichern pausiert</span>
            : displayedFailure !== null ? <span className="save-error">{displayedFailure.label}: {displayedFailure.message}</span>
            : <span className="save-dirty">{dirtyModules.map((module) => module.label).join(", ")}</span>}
        </span>
      </div>
      <button aria-label="Alle speichern" className="button button--save" disabled={saving || !online} onClick={() => void saveAll()} type="button">{saving ? <RotateCw className="spin" size={17} /> : <Save size={17} />}{saving ? "Wird gespeichert …" : "Alle speichern"}</button>
    </footer>
  );
};

const CompositionWorkspace = ({ initialBootstrap, api, initialTab }: { initialBootstrap: BootstrapResponse; api: AdminApi; initialTab: AdminWorkspaceId }) => {
  const [challengeUpdate, setChallengeUpdate] = useState<ChallengeUpdate | null>(null);
  const [challengeSettingsDraft, setChallengeSettingsDraft] = useState<ChallengeSettingsDraft | null>(null);
  const [challengePlacementDraft, setChallengePlacementDraft] = useState<ChallengePlacement | null>(null);
  const [previewZoom, setPreviewZoom] = useState(100);
  const [dragging, setDragging] = useState<"hud" | "challenges" | null>(null);
  const [activeTab, setActiveTab] = useState<AdminWorkspaceId>(initialTab);
  const draggingRef = useRef<{ kind: "hud" | "challenges"; pointerId: number } | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const [challengeCss, setChallengeCss] = useState<{ style: string | null; theme: string | null }>({ style: null, theme: null });
  const obsSetupTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [settingsHandle, setSettingsHandle] = useState<ModuleSaveHandle | null>(null);
  const [boardHandle, setBoardHandle] = useState<ChallengeBoardSaveHandle | null>(null);
  const state = useHudEditorState({ initialBootstrap, api, onChallengeUpdate: setChallengeUpdate });
  const committedThemeId = state.committed.themeId;
  useEffect(() => {
    if (api.getChallengeBoard === undefined) return;
    let disposed = false;
    void api.getChallengeBoard().then((snapshot) => { if (!disposed) setChallengeUpdate((current) => current ?? { eventSeq: snapshot.eventSeq, boardRevision: snapshot.boardRevision, settingsRevision: snapshot.settingsRevision, settings: { ...snapshot.settings, themeId: committedThemeId }, challenges: snapshot.challenges, event: null }); }).catch(() => undefined);
    return () => { disposed = true; };
  }, [api, committedThemeId]);
  const displayedChallengeUpdate = useMemo(() => challengeUpdate === null ? null : { ...challengeUpdate, settings: challengeSettingsWithDraft(challengeUpdate.settings, challengeSettingsDraft, committedThemeId) }, [challengeSettingsDraft, challengeUpdate, committedThemeId]);
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
  // Nur die Admin-Vorschau markiert das Modul hier als gedämpft. Die echte
  // Sammel-Overlay-Ausgabe bleibt unverändert; /overlay und /overlay/challenges
  // funktionieren als Einzel-URLs unabhängig vom Sammel-Overlay.
  const challengePreview = displayedChallengeUpdate === null || !challengeReady ? null : <ChallengeLogPreview ariaLabel="Challenge-Log verschieben, Pfeiltasten" className={`composition-draggable-module composition-draggable-module--challenge ${!state.draft.compositeChallengesVisible ? "is-module-muted" : ""} ${dragging === "challenges" ? "is-dragging" : ""}`} onKeyDown={(event) => movePlacementWithKeyboard("challenges", event)} onLostPointerCapture={(event) => stopDrag("challenges", event)} onPointerCancel={(event) => stopDrag("challenges", event)} onPointerDown={(event) => startDrag("challenges", event)} onPointerMove={(event) => moveDrag("challenges", event)} onPointerUp={(event) => stopDrag("challenges", event)} placement={effectiveChallengePlacement ?? displayedChallengeUpdate.settings.placement} rootTag="section" update={displayedChallengeUpdate} />;
  // Die Interaktion bleibt auch bei ausgeschaltetem Sammel-Overlay-Schalter in
  // der Admin-Vorschau aktiv. Die Einzel-URLs /overlay und /overlay/challenges
  // bleiben unabhängig vom Sammel-Overlay.
  const hudInteraction = { ariaLabel: "HUD-Modul verschieben, Pfeiltasten", className: `composition-draggable-module composition-draggable-module--hud ${dragging === "hud" ? "is-dragging" : ""}`, onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => movePlacementWithKeyboard("hud", event), onLostPointerCapture: (event: React.PointerEvent<HTMLDivElement>) => stopDrag("hud", event), onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => stopDrag("hud", event), onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => startDrag("hud", event), onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => moveDrag("hud", event), onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => stopDrag("hud", event) };
  // Positionen sind Teil des jeweiligen Moduls (HUD-Draft bzw. Challenge-Einstellungen-Draft)
  // und werden von der globalen Speicherleiste ganz normal mitgespeichert – kein eigener
  // Positions-Button/Endpunkt mehr noetig.
  const saveAllModules: SaveAllModule[] = [{ key: "hud", label: "HUD", tab: "hud", dirty: state.dirty, save: state.save }];
  if (settingsHandle !== null) saveAllModules.push({ key: "settings", label: "Einstellungen", tab: "challenges", dirty: settingsHandle.dirty, save: settingsHandle.save });
  if (boardHandle !== null) saveAllModules.push({ key: "board", label: "Board", tab: "challenges", dirty: boardHandle.dirty, save: boardHandle.save });
  return (
    <div className="admin-app admin-app--composition"><AdminTopbar api={api} initialBootstrap={initialBootstrap} obsSetupTriggerRef={obsSetupTriggerRef} state={state} />{!state.online && <div className="offline-banner">Offline – Speichern pausiert; bestehende Werte bleiben sichtbar.</div>}<AuditRail initialBootstrap={initialBootstrap} state={state} /><ObsSetupDialog api={api} state={state} triggerRef={obsSetupTriggerRef} /><main className="composition-main"><GlobalSaveBar modules={saveAllModules} online={state.online} onNavigate={setActiveTab} /><PreviewPanel headingControls={<ModuleVisibilityControls state={state} />} hudInteraction={hudInteraction} hudMuted={!state.draft.compositeHudVisible} mediaUrls={state.previewMediaUrls} onZoomChange={setPreviewZoom} previewOverlay={!state.committed.overlayEnabled ? <div className="disabled-veil">Overlay deaktiviert</div> : undefined} state={compositionHud} themeLabel={THEME_LABELS[state.preview.themeId]} zoom={previewZoom}>{challengePreview}</PreviewPanel></main><aside className="composition-rails"><AdminTabs activeTab={activeTab} onChange={setActiveTab} />{/* Beide Tabpanels bleiben dauerhaft gemountet (ChallengeBoard-Refetch/State sonst pro Tab-Wechsel weg); nur das inaktive wird per hidden-Attribut versteckt. */}<div aria-labelledby="admin-tab-hud" className="composition-tabpanel" hidden={activeTab !== "hud"} id="admin-composition-panel-hud" role="tabpanel"><HudEditorRail api={api} initialBootstrap={initialBootstrap} state={state} /></div><div aria-labelledby="admin-tab-challenges" className="composition-tabpanel" hidden={activeTab !== "challenges"} id="admin-composition-panel-challenges" role="tabpanel"><div className="composition-challenge-rail"><ChallengeSettingsPanel api={api} challengeUpdate={challengeUpdate} online={state.online} onDraftChange={setChallengeSettingsDraft} onHandleChange={setSettingsHandle} onPlacementDraftChange={setChallengePlacementDraft} placementDraft={challengePlacementDraft} />{compositionBoardApi === null ? <section className="challenge-board-shell" role="alert"><div className="challenge-board-empty"><AlertTriangle size={22} /><strong>Challenge-Board ist in dieser Sitzung nicht verfügbar.</strong></div></section> : <ChallengeBoard api={compositionBoardApi} challengeUpdate={displayedChallengeUpdate} online={state.online} onHandleChange={setBoardHandle} />}</div></div>{activeTab === "challenges" && <CompositionSaveDock state={state} />}</aside></div>
  );
};

export const AdminWorkspace = ({ initialBootstrap, api, workspace = "hud" }: { initialBootstrap: BootstrapResponse; api: AdminApi; workspace?: AdminWorkspaceId }) => <CompositionWorkspace api={api} initialBootstrap={initialBootstrap} initialTab={workspace} />;
