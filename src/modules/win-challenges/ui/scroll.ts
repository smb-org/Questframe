import { useCallback, useEffect, useRef, useState } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const DEFAULT_HOLD_MS = 2_000;
const CEREMONY_FOCUS_MS = 300;

export type ScrollDirection = "forward" | "backward";

export type FocusTargetRect = {
  top: number;
  bottom: number;
};

export type FocusViewport = {
  height: number;
};

export type FocusResolution = {
  outside: boolean;
  targetOffset: number;
};

const positiveModulo = (value: number, modulus: number): number =>
  ((value % modulus) + modulus) % modulus;

const clampOffset = (value: number, distance: number): number =>
  Math.min(distance, Math.max(0, value));

export const resolveFocus = (
  targetRect: FocusTargetRect,
  viewport: FocusViewport,
  offset: number,
  distance: number,
): FocusResolution => {
  const outside = targetRect.top < offset || targetRect.bottom > offset + viewport.height;
  const minimum = Math.max(0, targetRect.bottom - viewport.height);
  const maximum = Math.min(distance, targetRect.top);
  return {
    outside,
    targetOffset: clampOffset(Math.min(maximum, Math.max(minimum, offset)), distance),
  };
};

export const pingPongOffset = (
  tMs: number,
  distancePx: number,
  speedPxPerS: number,
  holdMs = DEFAULT_HOLD_MS,
): number => {
  if (distancePx <= 0 || speedPxPerS <= 0) return 0;
  const travelMs = distancePx / speedPxPerS * 1_000;
  const safeHoldMs = Math.max(0, holdMs);
  const periodMs = 2 * (travelMs + safeHoldMs);
  const phaseMs = positiveModulo(tMs, periodMs);
  if (phaseMs < safeHoldMs) return 0;
  if (phaseMs < safeHoldMs + travelMs) {
    return distancePx * (phaseMs - safeHoldMs) / travelMs;
  }
  if (phaseMs < safeHoldMs + travelMs + safeHoldMs) return distancePx;
  return distancePx * (1 - (phaseMs - safeHoldMs - travelMs - safeHoldMs) / travelMs);
};

/**
 * Returns a phase offset for the ping-pong clock that resumes at an already
 * visible offset while retaining the requested travel direction.
 */
export const rephase = (
  tMs: number,
  distancePx: number,
  speedPxPerS: number,
  currentOffsetPx: number,
  direction: ScrollDirection,
  holdMs = DEFAULT_HOLD_MS,
): number => {
  if (distancePx <= 0 || speedPxPerS <= 0) return 0;
  const travelMs = distancePx / speedPxPerS * 1_000;
  const safeHoldMs = Math.max(0, holdMs);
  const periodMs = 2 * (travelMs + safeHoldMs);
  const ratio = Math.min(1, Math.max(0, currentOffsetPx / distancePx));
  const desiredPhase = direction === "forward"
    ? safeHoldMs + ratio * travelMs
    : safeHoldMs + travelMs + safeHoldMs + (1 - ratio) * travelMs;
  return desiredPhase - positiveModulo(tMs, periodMs);
};

const readPrefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;

type ScrollMetrics = {
  distance: number;
  viewportHeight: number;
};

type CeremonyFocus = {
  targetId: string;
  startedAt: number;
  startOffset: number;
  targetOffset: number;
  direction: ScrollDirection;
  currentOffset: number;
};

export type ScrollOffsetOptions = {
  enabled: boolean;
  rowCount: number;
  speedPxPerS: number;
  ceremonyTargetId?: string | null;
  holdMs?: number;
};

export type ScrollOffsetResult = {
  viewport: (node: HTMLDivElement | null) => void;
  rows: (node: HTMLUListElement | null) => void;
  reducedMotion: boolean;
};

export const useScrollOffset = ({
  enabled,
  rowCount,
  speedPxPerS,
  ceremonyTargetId = null,
  holdMs = DEFAULT_HOLD_MS,
}: ScrollOffsetOptions): ScrollOffsetResult => {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLUListElement | null>(null);
  const setViewportRef = useCallback((node: HTMLDivElement | null) => { viewportRef.current = node; }, []);
  const setRowsRef = useCallback((node: HTMLUListElement | null) => { rowsRef.current = node; }, []);
  const targetIdRef = useRef<string | null>(ceremonyTargetId);
  const [reducedMotion, setReducedMotion] = useState(readPrefersReducedMotion);

  useEffect(() => {
    targetIdRef.current = ceremonyTargetId;
  }, [ceremonyTargetId]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (event: MediaQueryListEvent) => { setReducedMotion(event.matches); };
    query.addEventListener("change", onChange);
    return () => { query.removeEventListener("change", onChange); };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const rows = rowsRef.current;
    if (viewport === null || rows === null || !enabled || reducedMotion) {
      if (rows !== null) rows.style.transform = "";
      return;
    }

    let frame = 0;
    let disposed = false;
    let phaseOffset = 0;
    let lastOffset = 0;
    let lastDirection: ScrollDirection = "forward";
    let focus: CeremonyFocus | null = null;
    const metrics: ScrollMetrics = { distance: 0, viewportHeight: 0 };

    const measure = () => {
      const measuredRowHeight = [...rows.children]
        .slice(0, Math.max(0, rowCount))
        .reduce((height, row) => height + (row as HTMLElement).offsetHeight, 0);
      if (measuredRowHeight > 0) viewport.style.height = `${String(measuredRowHeight)}px`;
      metrics.viewportHeight = viewport.clientHeight || measuredRowHeight;
      metrics.distance = Math.max(0, rows.scrollHeight - metrics.viewportHeight);
    };
    measure();

    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(measure);
    resizeObserver?.observe(viewport);
    resizeObserver?.observe(rows);

    let resolvedTargetId: string | null = null;

    const tick = () => {
      if (disposed) return;
      const now = Date.now();
      if (metrics.distance <= 0) {
        rows.style.transform = "translateY(0px)";
        lastOffset = 0;
        frame = window.requestAnimationFrame(tick);
        return;
      }

      const targetId = targetIdRef.current;
      let offset = pingPongOffset(now + phaseOffset, metrics.distance, speedPxPerS, holdMs);
      if (targetId !== resolvedTargetId) {
        const previousFocus = focus;
        const previousOffset = previousFocus?.currentOffset ?? lastOffset;
        const previousDirection = previousFocus?.direction ?? lastDirection;
        if (resolvedTargetId !== null) {
          phaseOffset = rephase(now, metrics.distance, speedPxPerS, previousOffset, previousDirection, holdMs);
          offset = previousOffset;
        }
        focus = null;
        resolvedTargetId = targetId;

        if (targetId !== null) {
          const target = [...rows.querySelectorAll<HTMLElement>("[data-challenge-id]")]
            .find((candidate) => candidate.dataset.challengeId === targetId) ?? null;
          if (target !== null) {
            // offsetTop is relative to the positioned scroll viewport.
            const targetTop = target.offsetTop;
            const resolution = resolveFocus(
              { top: targetTop, bottom: targetTop + target.offsetHeight },
              { height: metrics.viewportHeight },
              offset,
              metrics.distance,
            );
            const direction: ScrollDirection = offset > lastOffset ? "forward" : offset < lastOffset ? "backward" : lastDirection;
            focus = {
              targetId,
              startedAt: now,
              startOffset: offset,
              targetOffset: resolution.targetOffset,
              direction,
              currentOffset: offset,
            };
          }
        }
      }

      if (focus !== null) {
        const progress = Math.min(1, Math.max(0, (now - focus.startedAt) / CEREMONY_FOCUS_MS));
        const eased = 1 - (1 - progress) ** 3;
        offset = focus.startOffset + (focus.targetOffset - focus.startOffset) * eased;
        focus.currentOffset = offset;
      }

      if (offset > lastOffset) lastDirection = "forward";
      else if (offset < lastOffset) lastDirection = "backward";
      lastOffset = offset;
      rows.style.transform = `translateY(-${String(offset)}px)`;
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      viewport.style.height = "";
      rows.style.transform = "";
    };
  }, [enabled, holdMs, reducedMotion, rowCount, speedPxPerS]);

  return { viewport: setViewportRef, rows: setRowsRef, reducedMotion };
};
