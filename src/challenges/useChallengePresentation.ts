import { useCallback, useEffect, useRef, useState } from "react";

import type { ChallengeUpdate } from "../shared/contracts/win-challenges";
import type { ChallengeLogCeremonyTarget } from "../modules/win-challenges/ui/ChallengeLog";
import { accountForChallengeUpdate } from "./wire";
import { createCeremonyAudioPolicy, type CeremonyAudioPolicy } from "./audio";
import { ceremonyFor, type ChallengeCeremony } from "./ceremonies";
import { loadChallengeStyle, type ChallengeStyleLoader } from "./style-loader";
import { loadChallengeTheme, type ChallengeThemeLoader } from "./theme-loader";

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
    const onChange = (event: MediaQueryListEvent) => { setReducedMotion(event.matches); };
    query.addEventListener("change", onChange);
    return () => { query.removeEventListener("change", onChange); };
  }, []);

  return reducedMotion;
};

type ChunkLoadState = "idle" | "ready" | "failed";

export type ChallengePresentationOptions = {
  update: ChallengeUpdate | null;
  loadStyle?: ChallengeStyleLoader;
  loadTheme?: ChallengeThemeLoader;
  loadThemes?: boolean;
};

export type ChallengePresentation = {
  ready: boolean;
  now: number;
  reducedMotion: boolean;
  ceremonyTarget: ChallengeLogCeremonyTarget | null;
  activeCeremony: (ChallengeCeremony & { eventSeq: number }) | null;
  setEffectsEnabled: (enabled: boolean) => void;
  acceptUpdate: (update: ChallengeUpdate) => void;
};

export const useChallengePresentation = ({
  update,
  loadStyle = loadChallengeStyle,
  loadTheme = loadChallengeTheme,
  loadThemes = true,
}: ChallengePresentationOptions): ChallengePresentation => {
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
  const effectsEnabledRef = useRef(true);
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
      setStyleLoadState({ key: styleId, state: "failed" });
    });
  }, [loadStyle, styleId]);

  useEffect(() => {
    const request = themeRequestRef.current + 1;
    themeRequestRef.current = request;
    if (!loadThemes || themeKey === null || themeId === null || themeMode === null || themeMode === "own") return;

    void loadTheme(themeId).then(() => {
      if (themeRequestRef.current !== request) return;
      setThemeLoadState({ key: themeKey, state: "ready" });
    }).catch(() => {
      if (themeRequestRef.current !== request) return;
      setThemeLoadState({ key: themeKey, state: "failed" });
    });
  }, [loadTheme, loadThemes, themeId, themeKey, themeMode]);

  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1_000);
    return () => { window.clearInterval(timer); };
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

  const stopEffects = useCallback((): void => {
    setActiveCeremony(null);
    if (ceremonyTimerRef.current !== null) {
      window.clearTimeout(ceremonyTimerRef.current);
      ceremonyTimerRef.current = null;
    }
    audioPolicyRef.current?.stop();
  }, []);

  const setEffectsEnabled = useCallback((enabled: boolean): void => {
    effectsEnabledRef.current = enabled;
    if (!enabled) stopEffects();
  }, [stopEffects]);

  const acceptUpdate = useCallback((nextUpdate: ChallengeUpdate): void => {
    const ceremony = accountForChallengeUpdate(nextUpdate, lastSeenRef.current);
    lastSeenRef.current = ceremony.lastSeen;
    const event = nextUpdate.event;
    const hiddenChallengeEvent = event !== null
      && event.scope === "challenge"
      && event.type !== "completed"
      && nextUpdate.challenges.some((challenge) => challenge.id === event.challengeId && challenge.hidden);

    if (!effectsEnabledRef.current || !nextUpdate.settings.effectsEnabled) {
      stopEffects();
    } else if (ceremony.shouldFire && event !== null && !hiddenChallengeEvent) {
      const nextCeremony = ceremonyFor(nextUpdate.settings.styleId, event);
      if (nextCeremony !== null) {
        const eventSeq = nextUpdate.eventSeq;
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
  }, [stopEffects]);

  useEffect(() => () => {
    if (ceremonyTimerRef.current !== null) window.clearTimeout(ceremonyTimerRef.current);
  }, []);

  const styleReady = update !== null
    && styleLoadState.key === styleId
    && styleLoadState.state === "ready";
  const themeReady = update !== null && (
    !loadThemes
    || update.settings.themeMode === "own"
    || (themeLoadState.key === themeKey && themeLoadState.state === "ready")
  );

  return {
    ready: styleReady && themeReady,
    now,
    reducedMotion,
    ceremonyTarget: activeCeremony?.target ?? null,
    activeCeremony,
    setEffectsEnabled,
    acceptUpdate,
  };
};
