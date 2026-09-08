import { useEffect, useState } from "react";

import type { ChallengeUpdate } from "../shared/contracts/win-challenges";
import { OVERLAY_SOCKET_PROTOCOL } from "../shared/contracts/protocol";
import {
  hasWatchdogReloadMarker,
  markWatchdogReload,
  nextReconnectDelayMs,
  reloadWindow,
  SOCKET_PONG_MESSAGE,
  startSocketHeartbeat,
} from "../shared/reconnect";
import { ChallengeCeremonyStage } from "./ChallengeCeremonyStage";
import {
  parseChallengeMessage,
  placementAtOriginFromLocation,
  tokenFromLocation,
} from "./wire";
import { loadChallengeStyle, type ChallengeStyleLoader } from "./style-loader";
import { loadChallengeTheme, type ChallengeThemeLoader } from "./theme-loader";
import { useChallengePresentation } from "./useChallengePresentation";

const PARSE_RELOAD_STORAGE_KEY = "wc-parse-reload-at";
const PARSE_RELOAD_COOLDOWN_MS = 5 * 60 * 1_000;

// Zeitstempelbasierte 5-Minuten-Sperre statt Overlays "ein Versuch pro
// Störung": Ein Parse-Fehler hier kann durch ein stehengebliebenes OBS-Bundle
// dauerhaft sein, ohne dass je wieder ein sauberer Zustand ankommt (der den
// Marker löschen würde) — die Sperre muss also von selbst verfallen.
const reloadAfterWireParseFailure = (reload: () => void): void => {
  if (hasWatchdogReloadMarker(PARSE_RELOAD_STORAGE_KEY, PARSE_RELOAD_COOLDOWN_MS)) return;
  // markWatchdogReload() try/catch-t intern; bei blockiertem Storage bleibt die
  // Quelle schwarz, statt ohne Sperre eine Reload-Schleife zu riskieren.
  if (!markWatchdogReload(PARSE_RELOAD_STORAGE_KEY)) return;
  reload();
};

type ChallengeSourceAppProps = {
  // Beide Loader bleiben injizierbar, damit die Quelle Rennen und Fehler testet.
  loadStyle?: ChallengeStyleLoader;
  // Der Loader bleibt injizierbar, damit das Render-Gate auch Fehler und Rennen testet.
  loadTheme?: ChallengeThemeLoader;
  reloadPage?: () => void;
};

export const ChallengeSourceApp = ({
  loadStyle = loadChallengeStyle,
  loadTheme = loadChallengeTheme,
  reloadPage = reloadWindow,
}: ChallengeSourceAppProps = {}) => {
  const [update, setUpdate] = useState<ChallengeUpdate | null>(null);
  // Der Hash ändert sich zur Laufzeit nicht; einmal beim Mount auslesen genügt.
  const [placementAtOrigin] = useState(placementAtOriginFromLocation);
  const presentation = useChallengePresentation({ update, loadStyle, loadTheme });
  const { acceptUpdate } = presentation;

  useEffect(() => {
    const token = tokenFromLocation();
    if (token === null) return;

    let disposed = false;
    let revoked = false;
    let socket: WebSocket | null = null;
    let stopHeartbeat: (() => void) | null = null;
    let retryTimer: number | null = null;
    let retry = 0;

    const connect = () => {
      if (disposed || revoked) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/challenge`, [
        OVERLAY_SOCKET_PROTOCOL,
        token,
      ]);
      socket.addEventListener("open", () => {
        stopHeartbeat?.();
        stopHeartbeat = startSocketHeartbeat(socket as WebSocket);
        retry = 0;
      });
      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") return;
        // Die automatische Antwort auf unseren Heartbeat ist kein JSON. Ohne diese
        // Zeile landet sie im Fehlerpfad für ein kaputtes Draht-Format: die Quelle
        // wird geleert und lädt neu — 20s nach jedem Verbinden.
        if (message.data === SOCKET_PONG_MESSAGE) return;
        let input: unknown;
        try {
          input = JSON.parse(message.data) as unknown;
        } catch {
          setUpdate(null);
          reloadAfterWireParseFailure(reloadPage);
          return;
        }
        const parsed = parseChallengeMessage(input);
        if (parsed === null) {
          // Ein Deploy kann das Wire-Format ändern, während OBS noch das alte Bundle hält.
          setUpdate(null);
          reloadAfterWireParseFailure(reloadPage);
          return;
        }
        if (!("eventSeq" in parsed)) {
          revoked = true;
          setUpdate(null);
          socket?.close();
          return;
        }
        acceptUpdate(parsed);
        setUpdate(parsed);
      });
      socket.addEventListener("close", () => {
        stopHeartbeat?.();
        stopHeartbeat = null;
        if (disposed || revoked) return;
        setUpdate(null);
        const delay = nextReconnectDelayMs(retry);
        retry += 1;
        retryTimer = window.setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      disposed = true;
      stopHeartbeat?.();
      stopHeartbeat = null;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [acceptUpdate, reloadPage]);

  if (!presentation.ready || update === null) return null;
  return (
    <ChallengeCeremonyStage
      placementAtOrigin={placementAtOrigin}
      presentation={presentation}
      update={update}
    />
  );
};
