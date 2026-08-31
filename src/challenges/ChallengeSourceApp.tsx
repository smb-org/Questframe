import { useEffect, useState } from "react";

import type { ChallengeUpdate } from "../shared/contracts/win-challenges";
import { OVERLAY_SOCKET_PROTOCOL } from "../shared/contracts/protocol";
import { ChallengeLog, type ChallengeLogCeremonyTarget } from "../modules/win-challenges/ui/ChallengeLog";
import {
  parseChallengeMessage,
  tokenFromLocation,
} from "./wire";
import { loadChallengeStyle, type ChallengeStyleLoader } from "./style-loader";
import { loadChallengeTheme, type ChallengeThemeLoader } from "./theme-loader";
import { useChallengePresentation } from "./useChallengePresentation";

const RETRY_BASE_MS = 750;
const PARSE_RELOAD_STORAGE_KEY = "wc-parse-reload-at";
const PARSE_RELOAD_COOLDOWN_MS = 5 * 60 * 1_000;

const reloadWindow = (): void => {
  window.location.reload();
};

const reloadAfterWireParseFailure = (reload: () => void): void => {
  try {
    const storage = window.sessionStorage;
    const now = Date.now();
    const storedAt = storage.getItem(PARSE_RELOAD_STORAGE_KEY);
    const lastReloadAt = storedAt === null ? null : Number(storedAt);
    if (lastReloadAt !== null && Number.isFinite(lastReloadAt) && now - lastReloadAt <= PARSE_RELOAD_COOLDOWN_MS) {
      return;
    }
    storage.setItem(PARSE_RELOAD_STORAGE_KEY, String(now));
    reload();
  } catch {
    // Im OBS-Kontext kann sessionStorage fehlen. Dann bleibt die Quelle schwarz,
    // statt ohne Sperre eine Reload-Schleife zu riskieren.
  }
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
  const presentation = useChallengePresentation({ update, loadStyle, loadTheme });
  const { acceptUpdate } = presentation;

  useEffect(() => {
    const token = tokenFromLocation();
    if (token === null) return;

    let disposed = false;
    let revoked = false;
    let socket: WebSocket | null = null;
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
        retry = 0;
      });
      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") return;
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
        if (disposed || revoked) return;
        setUpdate(null);
        const delay = Math.min(30_000, RETRY_BASE_MS * 2 ** retry);
        retry += 1;
        retryTimer = window.setTimeout(connect, delay + Math.floor(Math.random() * 400));
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [acceptUpdate, reloadPage]);

  if (!presentation.ready || update === null) return null;
  const ceremonyTarget: ChallengeLogCeremonyTarget | null = presentation.ceremonyTarget;
  return (
    <div
      key={presentation.activeCeremony?.eventSeq ?? "idle"}
      className="challenge-source-ceremony"
      data-ceremony-event={presentation.activeCeremony?.eventType}
      data-ceremony-motion={presentation.activeCeremony === null ? undefined : presentation.reducedMotion ? "static" : "animated"}
      data-ceremony-type={presentation.activeCeremony?.visual}
      data-style={update.settings.styleId}
    >
      <ChallengeLog ceremonyTarget={ceremonyTarget} now={presentation.now} update={update} />
    </div>
  );
};
