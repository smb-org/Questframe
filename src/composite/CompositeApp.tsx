import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ComponentType, LazyExoticComponent } from "react";

import type { ChannelState } from "../shared/contracts/state";
import type { ChallengeUpdate } from "../shared/contracts/win-challenges";
import { OVERLAY_SOCKET_PROTOCOL } from "../shared/contracts/protocol";
import {
  clearWatchdogReloadMarker,
  hasWatchdogReloadMarker,
  markWatchdogReload,
  nextReconnectDelayMs,
  reloadWindow,
  startSocketHeartbeat,
} from "../shared/reconnect";
import { ChallengeCeremonyStage } from "../challenges/ChallengeCeremonyStage";
import { loadChallengeStyle } from "../challenges/style-loader";
import type { ChallengeStyleLoader } from "../challenges/style-loader";
import { tokenFromLocation } from "../challenges/wire";
import { useChallengePresentation } from "../challenges/useChallengePresentation";
import type { BingoStyleLoader } from "../bingo/style-loader";
import type { BingoSourceApp } from "../bingo/BingoSourceApp";
import {
  fingerprintOverlayToken,
  loadOverlaySnapshot,
  removeOverlaySnapshot,
  storeOverlaySnapshot,
} from "../overlay/cache";
import { HudRenderer } from "../overlay/HudRenderer";
import { useOverlayMediaUrls } from "../overlay/useOverlayMediaUrls";
import { discriminateCompositeMessage } from "./wire";
import "./composite.css";

type BingoSourceModule = { default: ComponentType<NonNullable<ComponentProps<typeof BingoSourceApp>>> };
type BingoSourceLoader = () => Promise<BingoSourceModule>;

const loadBingoSource: BingoSourceLoader = () => import("../bingo/BingoSourceApp").then(({ BingoSourceApp: app }) => ({ default: app }));

type BingoSourceBoundaryProps = {
  loadSource: BingoSourceLoader;
  loadStyle?: BingoStyleLoader;
  onRetry: () => void;
  reloadPage: () => void;
};

type BingoSourceBoundaryState = {
  failed: boolean;
  source: LazyExoticComponent<ComponentType<NonNullable<ComponentProps<typeof BingoSourceApp>>>>;
};

const BINGO_SOURCE_RETRY_DELAY_MS = 30_000;

class BingoSourceErrorBoundary extends Component<BingoSourceBoundaryProps, BingoSourceBoundaryState> {
  constructor(props: BingoSourceBoundaryProps) {
    super(props);
    this.state = { failed: false, source: lazy(props.loadSource) };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  private retryTimer: number | null = null;

  // Im Stream nichts anzeigen: OBS-Quellen sind nicht klickbar, also still neu versuchen.
  // ponytail: festes Intervall ohne Obergrenze, Backoff erst wenn Chunk-Ausfälle real vorkommen.
  override componentDidCatch(): void {
    this.retryTimer = window.setTimeout(this.props.onRetry, BINGO_SOURCE_RETRY_DELAY_MS);
  }

  override componentWillUnmount(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
  }

  override render() {
    if (this.state.failed) return null;
    const BingoSource = this.state.source;
    return <Suspense fallback={null}><BingoSource {...(this.props.loadStyle === undefined ? {} : { loadStyle: this.props.loadStyle })} reloadPage={this.props.reloadPage} /></Suspense>;
  }
}

const COMPOSITE_WATCHDOG_MARKER = "irl-stream-hud:composite-watchdog-reload-at";
const COMPOSITE_WATCHDOG_DELAY_MS = 1_000;
// Schwelle für ein dauerhaft kaputtes Einzelmodul: scheitert ein Modul seit
// seinem ersten Fehlschlag ohne zwischenzeitliche erfolgreiche Nachricht länger
// als diese Zeitspanne, löst es allein einen Reload aus (das AND-Gate unten
// verlangt sonst, dass BEIDE Module gleichzeitig kaputt sind). 20s liegen
// bewusst über der üblichen Reconnect-Dauer (Backoff startet bei 750ms und
// deckt kurze Verbindungsrucker meist binnen weniger Sekunden ab), damit ein
// einzelner kaputter Frame oder ein kurzer Aussetzer nicht sofort einen Reload
// auslöst — aber deutlich unter der Größenordnung, in der ein still verschwundenes
// Modul (z.B. nach einem Deploy mit inkompatiblem State-Schema) unbemerkt bliebe.
const COMPOSITE_WATCHDOG_SUSTAINED_MS = 20_000;
const PARSE_RELOAD_COOLDOWN_MS = 5 * 60 * 1_000;

const clearWatchdogTimer = (timerRef: { current: number | null }): void => {
  if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  timerRef.current = null;
};

export type CompositeAppProps = {
  loadStyle?: ChallengeStyleLoader;
  loadBingoStyle?: BingoStyleLoader;
  loadBingoSource?: BingoSourceLoader;
  reloadPage?: () => void;
};

export const CompositeApp = ({
  loadStyle = loadChallengeStyle,
  loadBingoStyle: loadBingoStyleProp,
  loadBingoSource: loadBingoSourceProp,
  reloadPage = reloadWindow,
}: CompositeAppProps = {}) => {
  const [hudState, setHudState] = useState<ChannelState | null>(null);
  const [challengeUpdate, setChallengeUpdate] = useState<ChallengeUpdate | null>(null);
  const [bingoSourceGeneration, setBingoSourceGeneration] = useState(0);
  const hudParseFailedRef = useRef(false);
  const challengeParseFailedRef = useRef(false);
  // Letzte bekannte Mitgliedschaft der Challenges. State, nicht Ref: der Wert
  // wird im Render gebraucht, solange noch kein HUD-Zustand geparst wurde.
  const [lastKnownChallengesVisible, setLastKnownChallengesVisible] = useState(true);
  const watchdogTimerRef = useRef<number | null>(null);
  // Je Modul ein eigener Timer für den Sustained-Failure-Pfad (siehe
  // COMPOSITE_WATCHDOG_SUSTAINED_MS): läuft parallel zum AND-Gate-Timer oben.
  const hudSustainedTimerRef = useRef<number | null>(null);
  const challengeSustainedTimerRef = useRef<number | null>(null);
  const token = useMemo(() => tokenFromLocation(), []);
  const restartBingoSource = useCallback((): void => {
    setBingoSourceGeneration((generation) => generation + 1);
  }, []);
  const capsuleScope = window.location.host;
  const mediaUrls = useOverlayMediaUrls(hudState, token);
  const presentation = useChallengePresentation({
    update: challengeUpdate,
    loadStyle,
  });
  const { acceptUpdate, setEffectsEnabled } = presentation;

  useEffect(() => () => {
    clearWatchdogTimer(watchdogTimerRef);
    clearWatchdogTimer(hudSustainedTimerRef);
    clearWatchdogTimer(challengeSustainedTimerRef);
  }, []);

  useEffect(() => {
    if (token === null) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let stopHeartbeat: (() => void) | null = null;
    let retryTimer: number | null = null;
    let retry = 0;
    let fingerprint = "";
    let revoked = false;

    const parseFailedRefs = { hud: hudParseFailedRef, challenges: challengeParseFailedRef };
    const sustainedTimerRefs = { hud: hudSustainedTimerRef, challenges: challengeSustainedTimerRef };

    const scheduleWatchdog = () => {
      if (
        disposed
        || watchdogTimerRef.current !== null
        || hasWatchdogReloadMarker(COMPOSITE_WATCHDOG_MARKER, PARSE_RELOAD_COOLDOWN_MS)
        || !hudParseFailedRef.current
        || !challengeParseFailedRef.current
      ) return;
      watchdogTimerRef.current = window.setTimeout(() => {
        watchdogTimerRef.current = null;
        if (
          disposed
          || revoked
          || !hudParseFailedRef.current
          || !challengeParseFailedRef.current
          || hasWatchdogReloadMarker(COMPOSITE_WATCHDOG_MARKER, PARSE_RELOAD_COOLDOWN_MS)
          || !markWatchdogReload(COMPOSITE_WATCHDOG_MARKER)
        ) return;
        reloadPage();
      }, COMPOSITE_WATCHDOG_DELAY_MS);
    };

    // Sustained-Failure-Pfad: startet nur beim ERSTEN Fehlschlag einer Serie
    // (Timer läuft bereits -> kein Reset durch weitere Fehlschläge desselben
    // Moduls). Erholt sich das Modul, bricht recover() den Timer ab; die Uhr
    // zählt erst beim nächsten Fehlschlag neu.
    const scheduleSustainedWatchdog = (module: "hud" | "challenges") => {
      const timerRef = sustainedTimerRefs[module];
      if (disposed || timerRef.current !== null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (
          disposed
          || revoked
          || !parseFailedRefs[module].current
          || hasWatchdogReloadMarker(COMPOSITE_WATCHDOG_MARKER, PARSE_RELOAD_COOLDOWN_MS)
          || !markWatchdogReload(COMPOSITE_WATCHDOG_MARKER)
        ) return;
        reloadPage();
      }, COMPOSITE_WATCHDOG_SUSTAINED_MS);
    };

    const fail = (module: "hud" | "challenges") => {
      parseFailedRefs[module].current = true;
      scheduleWatchdog();
      scheduleSustainedWatchdog(module);
    };

    const recover = (module: "hud" | "challenges") => {
      parseFailedRefs[module].current = false;
      clearWatchdogTimer(sustainedTimerRefs[module]);
      if (!hudParseFailedRef.current && !challengeParseFailedRef.current) {
        clearWatchdogReloadMarker(COMPOSITE_WATCHDOG_MARKER);
      }
    };

    const connect = () => {
      if (disposed || revoked) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/composite`, [
        OVERLAY_SOCKET_PROTOCOL,
        token,
      ]);
      socket.addEventListener("open", () => {
        stopHeartbeat?.();
        stopHeartbeat = startSocketHeartbeat(socket as WebSocket);
        retry = 0;
        hudParseFailedRef.current = false;
        challengeParseFailedRef.current = false;
        clearWatchdogTimer(watchdogTimerRef);
        clearWatchdogTimer(hudSustainedTimerRef);
        clearWatchdogTimer(challengeSustainedTimerRef);
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let input: unknown;
        try {
          input = JSON.parse(event.data) as unknown;
        } catch {
          // Ohne JSON kann kein Modul sicher diskriminiert werden.
          return;
        }
        const discriminated = discriminateCompositeMessage(input);
        if (discriminated.kind === "ignore") return;
        if (discriminated.kind === "token_revoked") {
          if (discriminated.message === null) {
            fail("hud");
            fail("challenges");
            return;
          }
          revoked = true;
          setLastKnownChallengesVisible(false);
          setEffectsEnabled(false);
          recover("hud");
          recover("challenges");
          setHudState(null);
          setChallengeUpdate(null);
          if (fingerprint !== "") removeOverlaySnapshot(capsuleScope, fingerprint);
          socket?.close();
          return;
        }
        if (discriminated.kind === "hud") {
          if (discriminated.message === null) {
            fail("hud");
            return;
          }
          recover("hud");
          const challengesVisibleNext = discriminated.message.state.compositeChallengesVisible;
          setLastKnownChallengesVisible(challengesVisibleNext);
          setEffectsEnabled(challengesVisibleNext);
          setHudState(discriminated.message.state);
          if (fingerprint !== "") {
            storeOverlaySnapshot(capsuleScope, fingerprint, discriminated.message.state);
          }
          return;
        }
        if (discriminated.message === null || !("eventSeq" in discriminated.message)) {
          fail("challenges");
          return;
        }
        recover("challenges");
        acceptUpdate(discriminated.message);
        setChallengeUpdate(discriminated.message);
      });
      socket.addEventListener("close", () => {
        stopHeartbeat?.();
        stopHeartbeat = null;
        if (disposed || revoked) return;
        const delay = nextReconnectDelayMs(retry);
        retry += 1;
        retryTimer = window.setTimeout(connect, delay);
      });
    };

    void fingerprintOverlayToken(token)
      .then((value) => {
        if (disposed) return;
        fingerprint = value;
        const cached = loadOverlaySnapshot(capsuleScope, fingerprint);
        if (cached !== null) {
          setLastKnownChallengesVisible(cached.compositeChallengesVisible);
          setEffectsEnabled(cached.compositeChallengesVisible);
          setHudState(cached);
        }
      })
      .catch(() => {
        // Fingerprinting oder Cache-Laden ist optional.
      })
      .finally(() => {
        if (!disposed) connect();
      });

    return () => {
      disposed = true;
      stopHeartbeat?.();
      stopHeartbeat = null;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      clearWatchdogTimer(watchdogTimerRef);
      clearWatchdogTimer(hudSustainedTimerRef);
      clearWatchdogTimer(challengeSustainedTimerRef);
      socket?.close();
    };
  }, [acceptUpdate, capsuleScope, reloadPage, setEffectsEnabled, token]);

  const hud = hudState !== null && hudState.compositeHudVisible && hudState.overlayEnabled ? (
    <HudRenderer state={hudState} nowMilliseconds={presentation.now} mediaUrls={mediaUrls} />
  ) : null;
  const challengesVisible = hudState?.compositeChallengesVisible ?? lastKnownChallengesVisible;
  const challenges = challengesVisible
    && challengeUpdate !== null
    && presentation.ready ? (
      <ChallengeCeremonyStage presentation={presentation} update={challengeUpdate} />
    ) : null;
  const bingoVisible = hudState?.compositeBingoVisible ?? false;
  const bingo = bingoVisible
    ? <BingoSourceErrorBoundary key={bingoSourceGeneration} loadSource={loadBingoSourceProp ?? loadBingoSource} {...(loadBingoStyleProp === undefined ? {} : { loadStyle: loadBingoStyleProp })} onRetry={restartBingoSource} reloadPage={restartBingoSource} />
    : null;

  if (hud === null && challenges === null && bingo === null) return null;
  return <div aria-label="Zusammengesetzte Overlay-Quelle" className="composite-source" data-testid="composite-source">{hud}{challenges}{bingo}</div>;
};
