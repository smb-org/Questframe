import { useEffect, useRef, useState } from "react";

import type { ChallengeUpdate } from "../shared/contracts/win-challenges";
import { OVERLAY_SOCKET_PROTOCOL } from "../shared/contracts/protocol";
import { ChallengeLog, type ChallengeLogCeremonyTarget } from "../modules/win-challenges/ui/ChallengeLog";
import { createCeremonyAudioPolicy, type CeremonyAudioPolicy } from "./audio";
import { ceremonyFor, type ChallengeCeremony } from "./ceremonies";
import {
  accountForChallengeUpdate,
  parseChallengeMessage,
  tokenFromLocation,
} from "./wire";
import { loadChallengeStyle, type ChallengeStyleLoader } from "./style-loader";
import { loadChallengeTheme, type ChallengeThemeLoader } from "./theme-loader";

const RETRY_BASE_MS = 750;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const readPrefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;

const usePrefersReducedMotion = (): boolean => {
  const [reducedMotion, setReducedMotion] = useState(readPrefersReducedMotion);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reducedMotion;
};

type ChunkLoadState = "idle" | "ready" | "failed";

type ChallengeSourceAppProps = {
  // Beide Loader bleiben injizierbar, damit die Quelle Rennen und Fehler testet.
  loadStyle?: ChallengeStyleLoader;
  // Der Loader bleibt injizierbar, damit das Render-Gate auch Fehler und Rennen testet.
  loadTheme?: ChallengeThemeLoader;
};

export const ChallengeSourceApp = ({
  loadStyle = loadChallengeStyle,
  loadTheme = loadChallengeTheme,
}: ChallengeSourceAppProps = {}) => {
  const [update, setUpdate] = useState<ChallengeUpdate | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [themeLoadState, setThemeLoadState] = useState<{ key: string | null; state: ChunkLoadState }>({
    key: null,
    state: "idle",
  });
  const [styleLoadState, setStyleLoadState] = useState<{ key: string | null; state: ChunkLoadState }>({
    key: null,
    state: "idle",
  });
  const lastSeenRef = useRef(-1);
  const themeRequestRef = useRef(0);
  const styleRequestRef = useRef(0);
  const ceremonyTimerRef = useRef<number | null>(null);
  const audioPolicyRef = useRef<CeremonyAudioPolicy | null>(null);
  const [activeCeremony, setActiveCeremony] = useState<(ChallengeCeremony & { eventSeq: number }) | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const themeMode = update?.settings.themeMode ?? null;
  const themeId = update?.settings.themeId ?? null;
  const themeKey = themeMode === null || themeId === null ? null : `${themeMode}:${themeId}`;
  const styleId = update?.settings.styleId ?? null;

  useEffect(() => {
    const request = styleRequestRef.current + 1;
    styleRequestRef.current = request;

    if (styleId === null) return;

    void loadStyle(styleId).then(() => {
      if (styleRequestRef.current !== request) return;
      setStyleLoadState({ key: styleId, state: "ready" });
    }).catch(() => {
      if (styleRequestRef.current !== request) return;
      // Ein fehlerhafter Style-Chunk darf niemals ungestylten Inhalt zeigen.
      setStyleLoadState({ key: styleId, state: "failed" });
    });
  }, [loadStyle, styleId]);

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
    const policy = createCeremonyAudioPolicy();
    audioPolicyRef.current = policy;
    policy.preload();
    return () => {
      policy.stop();
      if (audioPolicyRef.current === policy) audioPolicyRef.current = null;
    };
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
        if (!parsed.settings.effectsEnabled) {
          setActiveCeremony(null);
          if (ceremonyTimerRef.current !== null) {
            window.clearTimeout(ceremonyTimerRef.current);
            ceremonyTimerRef.current = null;
          }
          audioPolicyRef.current?.stop();
        } else if (ceremony.shouldFire && parsed.event !== null) {
          const nextCeremony = ceremonyFor(parsed.settings.styleId, parsed.event);
          if (nextCeremony !== null) {
            const eventSeq = parsed.eventSeq;
            setActiveCeremony({ ...nextCeremony, eventSeq });
            audioPolicyRef.current?.play(nextCeremony.sound);
            if (ceremonyTimerRef.current !== null) window.clearTimeout(ceremonyTimerRef.current);
            ceremonyTimerRef.current = window.setTimeout(() => {
              setActiveCeremony((current) => current?.eventSeq === eventSeq ? null : current);
              ceremonyTimerRef.current = null;
            }, nextCeremony.durationMs);
          } else {
            setActiveCeremony(null);
            if (ceremonyTimerRef.current !== null) {
              window.clearTimeout(ceremonyTimerRef.current);
              ceremonyTimerRef.current = null;
            }
          }
        }
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
      if (ceremonyTimerRef.current !== null) window.clearTimeout(ceremonyTimerRef.current);
      socket?.close();
    };
  }, []);

  const styleReady = update !== null
    && styleLoadState.key === styleId
    && styleLoadState.state === "ready";
  const themeReady = update !== null && (
    update.settings.themeMode === "own" ||
    (themeLoadState.key === themeKey && themeLoadState.state === "ready")
  );
  if (!styleReady || !themeReady) return null;
  const ceremonyTarget: ChallengeLogCeremonyTarget | null = activeCeremony?.target ?? null;
  return (
    <div
      key={activeCeremony?.eventSeq ?? "idle"}
      className="challenge-source-ceremony"
      data-ceremony-event={activeCeremony?.eventType}
      data-ceremony-motion={activeCeremony === null ? undefined : reducedMotion ? "static" : "animated"}
      data-ceremony-type={activeCeremony?.visual}
      data-style={update.settings.styleId}
    >
      <ChallengeLog ceremonyTarget={ceremonyTarget} now={now} update={update} />
    </div>
  );
};
