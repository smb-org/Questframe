import { useCallback, useEffect, useRef, useState } from "react";

import type { BingoStyleId, BingoUpdateMessage } from "../modules/bingo/contracts/schemas";
import { bingoCeremonyFor, type BingoCeremony } from "./ceremonies";
import { loadBingoStyle, type BingoStyleLoader } from "./style-loader";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

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
}: {
  update: BingoUpdateMessage | null;
  loadStyle?: BingoStyleLoader;
}): BingoPresentation => {
  const [reducedMotion, setReducedMotion] = useState(readPrefersReducedMotion);
  const [styleLoadState, setStyleLoadState] = useState<{ key: BingoStyleId | null; state: ChunkLoadState }>({
    key: null,
    state: "idle",
  });
  const [activeCeremony, setActiveCeremony] = useState<BingoCeremony | null>(null);
  const styleRequestRef = useRef(0);
  const lastCeremonyRevisionRef = useRef(-1);
  const ceremonyTimerRef = useRef<number | null>(null);
  const styleId = update?.board.style ?? null;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (event: MediaQueryListEvent): void => { setReducedMotion(event.matches); };
    query.addEventListener("change", onChange);
    return () => { query.removeEventListener("change", onChange); };
  }, []);

  useEffect(() => {
    if (styleId === null) return;
    const request = styleRequestRef.current + 1;
    styleRequestRef.current = request;
    void loadStyle(styleId).then(() => {
      if (styleRequestRef.current === request) {
        setStyleLoadState({ key: styleId, state: "ready" });
      }
    }).catch(() => {
      if (styleRequestRef.current === request) {
        setStyleLoadState({ key: styleId, state: "failed" });
      }
    });
  }, [loadStyle, styleId]);

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
    if (ceremony === null) return;
    setActiveCeremony(ceremony);
    ceremonyTimerRef.current = window.setTimeout(() => {
      setActiveCeremony(null);
      ceremonyTimerRef.current = null;
    }, ceremony.durationMs);
  }, [clearCeremony]);

  useEffect(() => () => {
    if (ceremonyTimerRef.current !== null) window.clearTimeout(ceremonyTimerRef.current);
  }, []);

  return {
    ready: update !== null && styleLoadState.key === styleId && styleLoadState.state === "ready",
    reducedMotion,
    activeCeremony,
    acceptUpdate,
    clearCeremony,
  };
};
