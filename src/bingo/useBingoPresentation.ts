import { useCallback, useEffect, useRef, useState } from "react";

import type { BingoStyleId, BingoUpdateMessage } from "../modules/bingo/contracts/schemas";
import { createCeremonyAudioPolicy, type CeremonyAudioPolicy } from "../challenges/audio";
import { bingoCeremonyFor, type BingoCeremony } from "./ceremonies";
import { loadBingoStyle, type BingoStyleLoader } from "./style-loader";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const STYLE_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;

const readPrefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;

type ChunkLoadState = "idle" | "ready" | "failed";

export type BingoPresentation = {
  ready: boolean;
  reducedMotion: boolean;
  activeCeremony: BingoCeremony | null;
  acceptUpdate: (update: BingoUpdateMessage) => void;
  clearCeremony: () => void;
};

export const useBingoPresentation = ({
  update,
  loadStyle = loadBingoStyle,
  createAudio,
}: {
  update: BingoUpdateMessage | null;
  loadStyle?: BingoStyleLoader;
  createAudio?: (source: string) => HTMLAudioElement;
}): BingoPresentation => {
  const [reducedMotion, setReducedMotion] = useState(readPrefersReducedMotion);
  const [styleLoadState, setStyleLoadState] = useState<{ key: BingoStyleId | null; state: ChunkLoadState }>({
    key: null,
    state: "idle",
  });
  const [activeCeremony, setActiveCeremony] = useState<BingoCeremony | null>(null);
  const [styleRetryVersion, setStyleRetryVersion] = useState(0);
  const styleRequestRef = useRef(0);
  const styleRetryRef = useRef<{ styleId: BingoStyleId | null; retries: number }>({ styleId: null, retries: 0 });
  const lastCeremonyRevisionRef = useRef(-1);
  const ceremonyTimerRef = useRef<number | null>(null);
  const audioPolicyRef = useRef<CeremonyAudioPolicy | null>(null);
  const styleId = update?.board.style ?? null;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (event: MediaQueryListEvent): void => { setReducedMotion(event.matches); };
    query.addEventListener("change", onChange);
    return () => { query.removeEventListener("change", onChange); };
  }, []);

  useEffect(() => {
    const policy = createCeremonyAudioPolicy(createAudio === undefined ? {} : { createAudio });
    audioPolicyRef.current = policy;
    policy.preload();
    return () => {
      policy.stop();
      if (audioPolicyRef.current === policy) audioPolicyRef.current = null;
    };
  }, [createAudio]);

  useEffect(() => {
    if (styleId === null) return;
    if (styleRetryRef.current.styleId !== styleId) styleRetryRef.current = { styleId, retries: 0 };
    const request = styleRequestRef.current + 1;
    styleRequestRef.current = request;
    let retryTimer: number | null = null;
    void loadStyle(styleId).then(() => {
      if (styleRequestRef.current === request) {
        setStyleLoadState({ key: styleId, state: "ready" });
      }
    }).catch(() => {
      if (styleRequestRef.current === request) {
        setStyleLoadState({ key: styleId, state: "failed" });
        if (styleRetryRef.current.styleId === styleId) {
          const retryIndex = Math.min(styleRetryRef.current.retries, STYLE_RETRY_DELAYS_MS.length - 1);
          const retryDelay = STYLE_RETRY_DELAYS_MS[retryIndex] ?? STYLE_RETRY_DELAYS_MS[STYLE_RETRY_DELAYS_MS.length - 1];
          styleRetryRef.current.retries += 1;
          retryTimer = window.setTimeout(() => {
            if (styleRequestRef.current === request) setStyleRetryVersion((version) => version + 1);
          }, retryDelay);
        }
      }
    });
    return () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [loadStyle, styleId, styleRetryVersion]);

  const clearCeremony = useCallback((): void => {
    setActiveCeremony(null);
    if (ceremonyTimerRef.current !== null) window.clearTimeout(ceremonyTimerRef.current);
    ceremonyTimerRef.current = null;
  }, []);

  const acceptUpdate = useCallback((nextUpdate: BingoUpdateMessage): void => {
    const markRevision = nextUpdate.board.markRevision;
    if (markRevision <= lastCeremonyRevisionRef.current) return;
    lastCeremonyRevisionRef.current = markRevision;
    const ceremony = bingoCeremonyFor(nextUpdate.board.style, nextUpdate);
    clearCeremony();
    if (ceremony === null || nextUpdate.board.settings.ceremonyMode === "off") return;
    setActiveCeremony(ceremony);
    const sound = ceremony.type === "line"
      ? nextUpdate.board.settings.soundOnLine ? "complete" : null
      : nextUpdate.board.settings.soundOnFullCard ? "quest-complete" : null;
    audioPolicyRef.current?.play(sound);
    ceremonyTimerRef.current = window.setTimeout(() => {
      setActiveCeremony(null);
      ceremonyTimerRef.current = null;
    }, ceremony.durationMs);
  }, [clearCeremony]);

  useEffect(() => () => {
    if (ceremonyTimerRef.current !== null) window.clearTimeout(ceremonyTimerRef.current);
    audioPolicyRef.current?.stop();
  }, []);

  return {
    ready: update !== null && styleLoadState.key === styleId && styleLoadState.state === "ready",
    reducedMotion,
    activeCeremony,
    acceptUpdate,
    clearCeremony,
  };
};
