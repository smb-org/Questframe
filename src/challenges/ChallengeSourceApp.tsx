import { useEffect, useRef, useState } from "react";

import type { ChallengeUpdate } from "../shared/contracts/win-challenges";
import { OVERLAY_SOCKET_PROTOCOL } from "../shared/contracts/protocol";
import { ChallengeLog } from "../modules/win-challenges/ui/ChallengeLog";
import "./challenge-source.css";
import {
  accountForChallengeUpdate,
  parseChallengeMessage,
  tokenFromLocation,
} from "./wire";
import { loadChallengeTheme, type ChallengeThemeLoader } from "./theme-loader";

const RETRY_BASE_MS = 750;

type ThemeLoadState = "idle" | "ready" | "failed";

type ChallengeSourceAppProps = {
  // Der Loader bleibt injizierbar, damit das Render-Gate auch Fehler und Rennen testet.
  loadTheme?: ChallengeThemeLoader;
};

export const ChallengeSourceApp = ({ loadTheme = loadChallengeTheme }: ChallengeSourceAppProps = {}) => {
  const [update, setUpdate] = useState<ChallengeUpdate | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [themeLoadState, setThemeLoadState] = useState<{ key: string | null; state: ThemeLoadState }>({
    key: null,
    state: "idle",
  });
  const lastSeenRef = useRef(-1);
  const themeRequestRef = useRef(0);

  const themeMode = update?.settings.themeMode ?? null;
  const themeId = update?.settings.themeId ?? null;
  const themeKey = themeMode === null || themeId === null ? null : `${themeMode}:${themeId}`;

  useEffect(() => {
    const request = themeRequestRef.current + 1;
    themeRequestRef.current = request;

    if (themeKey === null || themeId === null || themeMode === null) {
      return;
    }

    if (themeMode === "own") {
      // `own` benoetigt keinen HUD-Chunk. Die eigenen Tokens liegen im Basis-CSS.
      return;
    }

    void loadTheme(themeId).then(() => {
      if (themeRequestRef.current !== request) return;
      setThemeLoadState({ key: themeKey, state: "ready" });
    }).catch(() => {
      if (themeRequestRef.current !== request) return;
      // Ein fehlerhafter Chunk darf niemals ungestylten Inhalt ins Streambild lassen.
      setThemeLoadState({ key: themeKey, state: "failed" });
    });
  }, [loadTheme, themeId, themeKey, themeMode]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

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
          return;
        }
        const parsed = parseChallengeMessage(input);
        if (parsed === null) {
          // Ein Parse-Fehler darf das HUD vor Zuschauern niemals neu laden.
          setUpdate(null);
          return;
        }
        if (!("eventSeq" in parsed)) {
          revoked = true;
          setUpdate(null);
          socket?.close();
          return;
        }
        const ceremony = accountForChallengeUpdate(parsed, lastSeenRef.current);
        lastSeenRef.current = ceremony.lastSeen;
        // Schritt 13 hängt die Zeremonie an `ceremony.shouldFire` ein. Die
        // lastSeen-Buchführung läuft schon jetzt, damit dort nur noch der
        // Effekt fehlt und nicht die Regel, wann er feuern darf.
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
  }, []);

  // Der statische Import von challenge-source.css ist Teil dieses Moduls und ist
  // abgeschlossen, bevor Vite den Modul-Promise der Quelle aufloest.
  const themeReady = update !== null && (
    update.settings.themeMode === "own" ||
    (themeLoadState.key === themeKey && themeLoadState.state === "ready")
  );
  if (!themeReady) return null;
  return <ChallengeLog now={now} update={update} />;
};
