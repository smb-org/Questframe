import { useCallback, useEffect, useRef, useState } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const DEFAULT_HOLD_MS = 2_000;
const CEREMONY_FOCUS_MS = 300;

export type ScrollDirection = "forward" | "backward";

const positiveModulo = (value: number, modulus: number): number =>
  ((value % modulus) + modulus) % modulus;

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

    const clamp = (value: number): number => Math.min(metrics.distance, Math.max(0, value));
    const targetOffsetFor = (target: HTMLElement, currentOffset: number): number => {
      const top = target.offsetTop;
      const bottom = top + target.offsetHeight;
      const minimum = Math.max(0, bottom - metrics.viewportHeight);
      const maximum = Math.min(metrics.distance, top);
      return clamp(Math.min(maximum, Math.max(minimum, currentOffset)));
    };

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
      if (focus !== null && focus.targetId !== targetId) {
        phaseOffset = rephase(now, metrics.distance, speedPxPerS, focus.currentOffset, focus.direction, holdMs);
        lastOffset = focus.currentOffset;
        focus = null;
      }

      let offset = pingPongOffset(now + phaseOffset, metrics.distance, speedPxPerS, holdMs);
      if (focus === null && targetId !== null) {
        const target = [...rows.querySelectorAll<HTMLElement>("[data-challenge-id]")]
          .find((candidate) => candidate.dataset.challengeId === targetId) ?? null;
        if (target !== null) {
          const targetOffset = targetOffsetFor(target, offset);
          const targetTop = target.offsetTop;
          const targetBottom = targetTop + target.offsetHeight;
          const outside = targetTop < offset || targetBottom > offset + metrics.viewportHeight;
          if (outside) {
            const direction: ScrollDirection = offset > lastOffset ? "forward" : offset < lastOffset ? "backward" : lastDirection;
            focus = {
              targetId,
              startedAt: now,
              startOffset: offset,
              targetOffset,
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
