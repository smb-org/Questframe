import { useEffect, useMemo, useState } from "react";

import { OVERLAY_SOCKET_PROTOCOL } from "../shared/contracts/protocol";
import type { ChannelState } from "../shared/contracts/state";
import {
  clearWatchdogReloadMarker,
  hasWatchdogReloadMarker,
  markWatchdogReload,
  nextReconnectDelayMs,
  reloadWindow,
} from "../shared/reconnect";
import {
  fingerprintOverlayToken,
  loadOverlaySnapshot,
  removeOverlaySnapshot,
  storeOverlaySnapshot,
} from "./cache";
import { HudRenderer } from "./HudRenderer";
import { isStateBearingMessage } from "./message-policy";
import { useOverlayMediaUrls } from "./useOverlayMediaUrls";
import { parseOverlayMessage } from "./wire";

const OVERLAY_WATCHDOG_MARKER = "irl-stream-hud:overlay-watchdog-reload-at";
const OVERLAY_WATCHDOG_DELAY_MS = 1_000;

// Höchstens ein automatischer Heilversuch pro Störung: Solange der Marker
// gesetzt ist, blieb der letzte Reload wirkungslos (sonst wäre er über den
// "snapshot"/"state_committed"-Zweig längst gelöscht worden) — ein weiterer
// Reload würde also nur denselben dauerhaft unparsbaren Zustand wiederholen.
// Deshalb hier ohne cooldownMs: reine Existenzprüfung, kein Verfall.

export const OverlayApp = ({ reloadPage = reloadWindow }: { reloadPage?: () => void } = {}) => {
  const [state, setState] = useState<ChannelState | null>(null);
  const [nowMilliseconds, setNowMilliseconds] = useState(() => Date.now());
  const params = useMemo(
    () => new URLSearchParams(window.location.hash.replace(/^#/, "")),
    [],
  );
  const token = params.get("token");
  const capsuleScope = window.location.host;
  const mediaUrls = useOverlayMediaUrls(state, token);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMilliseconds(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (token === null || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    let retry = 0;
    let fingerprint = "";
    let revoked = false;
    let watchdogTimer: number | null = null;

    const cancelWatchdog = () => {
      if (watchdogTimer !== null) window.clearTimeout(watchdogTimer);
      watchdogTimer = null;
    };

    const scheduleWatchdog = () => {
      if (disposed || watchdogTimer !== null || hasWatchdogReloadMarker(OVERLAY_WATCHDOG_MARKER)) return;
      watchdogTimer = window.setTimeout(() => {
        watchdogTimer = null;
        if (disposed || revoked || hasWatchdogReloadMarker(OVERLAY_WATCHDOG_MARKER) || !markWatchdogReload(OVERLAY_WATCHDOG_MARKER)) return;
        reloadPage();
      }, OVERLAY_WATCHDOG_DELAY_MS);
    };

    const connect = () => {
      if (disposed || revoked) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/overlay`, [
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
          return;
        }
        const parsed = parseOverlayMessage(input);
        if (parsed === null) {
          // `challenge_update` gehört zur eigenen Quelle: ein Parse-Fehler dort
          // darf das HUD vor Zuschauern niemals neu laden.
          if (isStateBearingMessage(input)) scheduleWatchdog();
          return;
        }
        if (parsed.type === "snapshot" || parsed.type === "state_committed") {
          cancelWatchdog();
          clearWatchdogReloadMarker(OVERLAY_WATCHDOG_MARKER);
          setState(parsed.state);
          if (fingerprint !== "") {
            storeOverlaySnapshot(capsuleScope, fingerprint, parsed.state);
          }
        } else {
          revoked = true;
          cancelWatchdog();
          setState(null);
          if (fingerprint !== "") removeOverlaySnapshot(capsuleScope, fingerprint);
          socket?.close();
        }
      });
      socket.addEventListener("close", () => {
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
        if (cached !== null) setState(cached);
      })
      .catch(() => {
        // Fingerprinting or cache load failed, proceed anyway
      })
      .finally(() => {
        if (!disposed) connect();
      });

    return () => {
      disposed = true;
      cancelWatchdog();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [capsuleScope, reloadPage, token]);

  return state === null ? null : (
    <HudRenderer state={state} nowMilliseconds={nowMilliseconds} mediaUrls={mediaUrls} />
  );
};
