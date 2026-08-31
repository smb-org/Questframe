import { useEffect, useMemo, useRef, useState } from "react";

import type { ChannelState } from "../shared/contracts/state";
import type { ChallengeUpdate } from "../shared/contracts/win-challenges";
import { OVERLAY_SOCKET_PROTOCOL } from "../shared/contracts/protocol";
import { ChallengeLog } from "../modules/win-challenges/ui/ChallengeLog";
import { loadChallengeStyle } from "../challenges/style-loader";
import type { ChallengeStyleLoader } from "../challenges/style-loader";
import { tokenFromLocation } from "../challenges/wire";
import { useChallengePresentation } from "../challenges/useChallengePresentation";
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

const COMPOSITE_WATCHDOG_MARKER = "irl-stream-hud:composite-watchdog-reload-at";
const COMPOSITE_WATCHDOG_DELAY_MS = 1_000;
const RETRY_BASE_MS = 750;

const reloadWindow = (): void => {
  window.location.reload();
};

const hasWatchdogReloadMarker = (): boolean => {
  try {
    return window.sessionStorage.getItem(COMPOSITE_WATCHDOG_MARKER) !== null;
  } catch {
    return false;
  }
};

const markWatchdogReload = (): boolean => {
  try {
    window.sessionStorage.setItem(COMPOSITE_WATCHDOG_MARKER, String(Date.now()));
    return true;
  } catch {
    return false;
  }
};

const clearWatchdogReloadMarker = (): void => {
  try {
    window.sessionStorage.removeItem(COMPOSITE_WATCHDOG_MARKER);
  } catch {
    // Session-Storage ist optional; ein fehlender Marker ist kein Composite-Fehler.
  }
};

export type CompositeAppProps = {
  loadStyle?: ChallengeStyleLoader;
  reloadPage?: () => void;
};

export const CompositeApp = ({
  loadStyle = loadChallengeStyle,
  reloadPage = reloadWindow,
}: CompositeAppProps = {}) => {
  const [hudState, setHudState] = useState<ChannelState | null>(null);
  const [challengeUpdate, setChallengeUpdate] = useState<ChallengeUpdate | null>(null);
  const hudParseFailedRef = useRef(false);
  const challengeParseFailedRef = useRef(false);
  const compositeChallengesVisibleRef = useRef(true);
  const watchdogTimerRef = useRef<number | null>(null);
  const token = useMemo(() => tokenFromLocation(), []);
  const capsuleScope = window.location.host;
  const mediaUrls = useOverlayMediaUrls(hudState, token);
  const presentation = useChallengePresentation({
    update: challengeUpdate,
    loadStyle,
    loadThemes: false,
  });
  const { acceptUpdate, setEffectsEnabled } = presentation;

  useEffect(() => () => {
    if (watchdogTimerRef.current !== null) window.clearTimeout(watchdogTimerRef.current);
  }, []);

  useEffect(() => {
    if (token === null) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    let retry = 0;
    let fingerprint = "";
    let revoked = false;

    const scheduleWatchdog = () => {
      if (
        disposed
        || watchdogTimerRef.current !== null
        || hasWatchdogReloadMarker()
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
          || hasWatchdogReloadMarker()
          || !markWatchdogReload()
        ) return;
        reloadPage();
      }, COMPOSITE_WATCHDOG_DELAY_MS);
    };

    const fail = (module: "hud" | "challenges") => {
      if (module === "hud") {
        hudParseFailedRef.current = true;
      } else {
        challengeParseFailedRef.current = true;
      }
      scheduleWatchdog();
    };

    const recover = (module: "hud" | "challenges") => {
      if (module === "hud") {
        hudParseFailedRef.current = false;
      } else {
        challengeParseFailedRef.current = false;
      }
      clearWatchdogReloadMarker();
    };

    const connect = () => {
      if (disposed || revoked) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/composite`, [
        OVERLAY_SOCKET_PROTOCOL,
        token,
      ]);
      socket.addEventListener("open", () => {
        retry = 0;
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
          compositeChallengesVisibleRef.current = false;
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
          if (discriminated.message === null || discriminated.message.type === "token_revoked") {
            fail("hud");
            return;
          }
          recover("hud");
          compositeChallengesVisibleRef.current = discriminated.message.state.compositeChallengesVisible;
          setEffectsEnabled(compositeChallengesVisibleRef.current);
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
        if (disposed || revoked) return;
        const delay = Math.min(30_000, RETRY_BASE_MS * 2 ** retry);
        retry += 1;
        retryTimer = window.setTimeout(connect, delay + Math.floor(Math.random() * 400));
      });
    };

    void fingerprintOverlayToken(token)
      .then((value) => {
        if (disposed) return;
        fingerprint = value;
        const cached = loadOverlaySnapshot(capsuleScope, fingerprint);
        if (cached !== null) {
          compositeChallengesVisibleRef.current = cached.compositeChallengesVisible;
          setEffectsEnabled(compositeChallengesVisibleRef.current);
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
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (watchdogTimerRef.current !== null) window.clearTimeout(watchdogTimerRef.current);
      socket?.close();
    };
  }, [acceptUpdate, capsuleScope, reloadPage, setEffectsEnabled, token]);

  const hud = hudState !== null && hudState.compositeHudVisible && hudState.overlayEnabled ? (
    <HudRenderer state={hudState} nowMilliseconds={presentation.now} mediaUrls={mediaUrls} />
  ) : null;
  const challenges = hudState?.compositeChallengesVisible === true
    && challengeUpdate !== null
    && presentation.ready ? (
      <div
        key={presentation.activeCeremony?.eventSeq ?? "idle"}
        className="challenge-source-ceremony"
        data-ceremony-event={presentation.activeCeremony?.eventType}
        data-ceremony-motion={presentation.activeCeremony === null ? undefined : presentation.reducedMotion ? "static" : "animated"}
        data-ceremony-type={presentation.activeCeremony?.visual}
        data-style={challengeUpdate.settings.styleId}
      >
        <ChallengeLog
          ceremonyTarget={presentation.ceremonyTarget}
          now={presentation.now}
          update={challengeUpdate}
        />
      </div>
    ) : null;

  if (hud === null && challenges === null) return null;
  return <div aria-label="Zusammengesetzte Overlay-Quelle" className="composite-source" data-testid="composite-source">{hud}{challenges}</div>;
};
