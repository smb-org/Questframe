import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEventHandler, type PointerEventHandler, type ReactNode } from "react";

import type {
  ActiveEffect,
  ChannelState,
  PortraitRef,
} from "../shared/contracts/state";
import { formatRemainingTime, getRemainingSeconds } from "../shared/domain/effects";
import { getHealthTier } from "./health";
import "./hud.css";
import "./themes/trail-wood/theme.css";
import "./themes/field-journal/theme.css";
import "./themes/forged-compass/theme.css";
import "./themes/classic-simple/theme.css";
import "./themes/modern-compact/theme.css";
import "./themes/modern-minimal/theme.css";

type HudStyle = CSSProperties & {
  "--hud-x": string;
  "--hud-y": string;
  "--hud-scale": string;
};

type PortraitProps = {
  portrait: PortraitRef;
  name: string;
  mediaUrls?: ReadonlyMap<string, string> | undefined;
};

const initialsFor = (name: string): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();

const portraitUrl = (
  portrait: PortraitRef,
  mediaUrls?: ReadonlyMap<string, string>,
): string | null => {
  if (portrait.kind === "bundled") return `/assets/portraits/${portrait.assetId}.webp`;
  if (portrait.kind === "twitch") return portrait.url;
  if (portrait.kind === "uploaded") return mediaUrls?.get(portrait.contentHash) ?? null;
  return null;
};

const Portrait = ({ portrait, name, mediaUrls }: PortraitProps) => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = portraitUrl(portrait, mediaUrls);
  const initials = portrait.kind === "initials" ? portrait.text : initialsFor(name);
  return url !== null && failedUrl !== url ? (
    <img
      alt=""
      className="hud-portrait-image"
      draggable={false}
      src={url}
      onError={() => {
        setFailedUrl(url);
      }}
    />
  ) : (
    <span className="hud-portrait-fallback" aria-hidden="true">
      {initials}
    </span>
  );
};

/*
 * Auto-Fit fuer den Spielernamen. Die Plakette hat je Variante eine feste
 * Breite; ein zu langer Name wird deshalb nicht abgeschnitten, sondern in der
 * Schriftgroesse heruntergerechnet. Unterhalb von MINIMUM_NAME_FIT greift
 * weiterhin das text-overflow der CSS-Regel.
 *
 * Nur der Spielername. Pet- und Party-Namen bleiben unangetastet.
 */
const MINIMUM_NAME_FIT = 0.7;
/* Ganzzahlig gerundete Layoutwerte duerfen kurze Namen nicht verkleinern. */
const NAME_FIT_TOLERANCE = 1;

const nameFitFactor = (available: number, needed: number): number => {
  // In jsdom gibt es keine Layout-Engine: ohne Messwerte bleibt der Faktor 1.
  if (available <= 0 || needed <= 0) return 1;
  if (needed <= available + NAME_FIT_TOLERANCE) return 1;
  return Math.max(MINIMUM_NAME_FIT, available / needed);
};

const PlayerName = ({
  name,
  themeId,
  autoFit = true,
}: {
  name: string;
  themeId: string;
  autoFit?: boolean;
}) => {
  const labelRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    if (!autoFit) return;
    const label = labelRef.current;
    if (label === null) return;

    let disposed = false;
    const measure = () => {
      if (disposed) return;
      // Erst zuruecksetzen, sonst misst die naechste Messung den bereits
      // verkleinerten Text.
      label.style.setProperty("--hud-name-fit", "1");
      const factor = nameFitFactor(label.clientWidth, label.scrollWidth);
      label.style.setProperty("--hud-name-fit", String(factor));
    };

    measure();

    // Der Container aendert seine Breite bei Varianten- und Skalenwechsel.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (observer !== null && label.parentElement !== null) observer.observe(label.parentElement);

    // Webfonts kommen spaeter als der erste Layoutdurchlauf. jsdom kennt
    // document.fonts nicht, die Typdeklaration behauptet das Gegenteil.
    const fonts = (document as Partial<Document>).fonts;
    if (fonts !== undefined) void fonts.ready.then(measure).catch(() => undefined);

    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, [autoFit, name, themeId]);

  return (
    <span className="hud-player-name" ref={labelRef}>
      {name}
    </span>
  );
};

type BarProps = {
  percent: number;
  kind: "health" | "resource";
  label: string;
  color?: string;
  testId?: string;
  compact?: boolean;
};

const Bar = ({ percent, kind, label, color, testId, compact = false }: BarProps) => {
  const tier = kind === "health" ? getHealthTier(percent) : undefined;
  const style = {
    "--bar-value": `${String(percent)}%`,
    ...(color === undefined ? {} : { "--bar-color": color }),
  } as CSSProperties;
  return (
    <div
      aria-label={`${label} ${String(percent)} Prozent`}
      className={`hud-bar hud-bar--${kind}${compact ? " hud-bar--compact" : ""}`}
      data-health-tier={tier}
      data-testid={testId}
      role="meter"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent}
    >
      <span className="hud-bar-fill" style={style} />
      <span className="hud-bar-shine" />
    </div>
  );
};

const EffectIcon = ({ effect, remaining }: { effect: ActiveEffect; remaining: number | null }) => {
  const [failedIconId, setFailedIconId] = useState<string | null>(null);
  const failed = failedIconId === effect.iconId;
  return (
    <div className={`hud-effect hud-effect--${effect.kind}`} title={effect.description ?? effect.name}>
      {failed ? (
        <span className="hud-effect-fallback">{effect.kind === "buff" ? "+" : "\u2212"}</span>
      ) : (
        <img
          alt=""
          draggable={false}
          src={`/assets/effects/${effect.iconId}.webp`}
          onError={() => {
            setFailedIconId(effect.iconId);
          }}
        />
      )}
      <span className="hud-effect-bezel" aria-hidden="true" />
      <span className="hud-sr-only">{effect.name}</span>
      {effect.stacks !== null && <span className="hud-effect-stacks">{effect.stacks}</span>}
      {remaining !== null && <span className="hud-effect-time">{formatRemainingTime(remaining)}</span>}
    </div>
  );
};

const CompactUnit = ({
  name,
  portrait,
  hpPercent,
  unitKind,
  mediaUrls,
  twitch = false,
  className = "",
}: {
  name: string;
  portrait: PortraitRef;
  hpPercent: number;
  unitKind: "pet" | "party";
  mediaUrls?: ReadonlyMap<string, string> | undefined;
  twitch?: boolean;
  className?: string;
}) => (
  <div className={`hud-compact-unit ${className}`} data-unit-kind={unitKind}>
    <div className="hud-compact-portrait">
      <div className="hud-compact-portrait-clip">
        <Portrait portrait={portrait} name={name} mediaUrls={mediaUrls} />
      </div>
    </div>
    <span className="hud-compact-chrome" aria-hidden="true" />
    <div className="hud-compact-name-row">
      <span className="hud-compact-name">{name}</span>
      {twitch && (
        <span className="hud-twitch-mark" aria-label="Twitch-Gast" role="img" title="Twitch">
          <img alt="" src="/assets/brands/twitch.svg" />
        </span>
      )}
    </div>
    <div className="hud-compact-bar">
      <Bar percent={hpPercent} kind="health" label={`${name} Gesundheit`} compact />
    </div>
  </div>
);

export type HudRendererProps = {
  state: ChannelState;
  nowMilliseconds?: number;
  mediaUrls?: ReadonlyMap<string, string> | undefined;
  previewOverlay?: ReactNode;
  forceVisible?: boolean;
  autoFitPlayerName?: boolean;
  className?: string;
  ariaLabel?: string;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerUp?: PointerEventHandler<HTMLDivElement>;
  onPointerCancel?: PointerEventHandler<HTMLDivElement>;
  onLostPointerCapture?: PointerEventHandler<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
};

export const HudRenderer = ({
  state,
  nowMilliseconds,
  mediaUrls,
  previewOverlay,
  forceVisible = false,
  autoFitPlayerName = true,
  className,
  ariaLabel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  onKeyDown,
}: HudRendererProps) => {
  const [initialNow] = useState(() => Date.now());
  const effectiveNow = nowMilliseconds ?? initialNow;
  if (!state.overlayEnabled && !forceVisible) return null;
  const visibleEffects = state.effects
    .map((effect) => ({ effect, remaining: getRemainingSeconds(effect.expiresAt, effectiveNow) }))
    .filter(({ effect, remaining }) => effect.expiresAt === null || remaining !== 0);
  const featured = visibleEffects.find(({ effect }) => effect.id === state.featuredEffectId);
  const style: HudStyle = {
    "--hud-x": `${String(state.placement.x)}px`,
    "--hud-y": `${String(state.placement.y)}px`,
    "--hud-scale": String(state.placement.scale),
  };

  return (
    <div
      className={`hud-root hud-theme--${state.themeId}${!state.overlayEnabled ? " hud-root--disabled-preview" : ""}`}
      style={style}
      data-theme={state.themeId}
    >
      <div
        aria-label={ariaLabel}
        className={`hud-stage${className === undefined ? "" : ` ${className}`}`}
        onKeyDown={onKeyDown}
        onLostPointerCapture={onLostPointerCapture}
        onPointerCancel={onPointerCancel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        tabIndex={ariaLabel === undefined ? undefined : 0}
      >
        <section className="hud-player" aria-label={`${state.player.name} Unitframe`}>
          <div className="hud-player-portrait">
            <div className="hud-player-portrait-clip">
              <Portrait portrait={state.player.portrait} name={state.player.name} mediaUrls={mediaUrls} />
            </div>
          </div>
          <span className="hud-player-chrome" aria-hidden="true" />
          <div className="hud-player-body">
            <div className="hud-player-heading">
              <PlayerName
                autoFit={autoFitPlayerName}
                name={state.player.name}
                themeId={state.themeId}
              />
            </div>
            {state.player.title !== null && <span className="hud-player-title">{state.player.title}</span>}
            <div className="hud-player-bars">
              <Bar
                percent={state.player.hpPercent}
                kind="health"
                label="Gesundheit"
                testId="player-health"
              />
              <Bar
                percent={state.player.resource.percent}
                kind="resource"
                label={state.player.resource.name}
                color={state.player.resource.color}
              />
            </div>
          </div>
          <div className="hud-level-medallion" data-testid="player-level">
            <span className="hud-level-chrome" aria-hidden="true" />
            <span className="hud-level-value">{state.player.level}</span>
          </div>
        </section>

        <div className="hud-support-row">
          <div className="hud-left-support">
            <div className="hud-effects" aria-label="Aktive Effekte">
              {visibleEffects.map(({ effect, remaining }) => (
                <EffectIcon key={effect.id} effect={effect} remaining={remaining} />
              ))}
            </div>
            <div className="hud-pet-slot">
              {state.pet !== null && state.petVisible && (
                <CompactUnit
                  className="hud-pet"
                  name={state.pet.name}
                  portrait={state.pet.portrait}
                  hpPercent={state.pet.hpPercent}
                  unitKind="pet"
                  mediaUrls={mediaUrls}
                />
              )}
            </div>
          </div>
          <div className="hud-feature-slot">
            {featured !== undefined && featured.effect.description !== null && (
              <div className={`hud-feature hud-feature--${featured.effect.kind}`}>
                <div className="hud-feature-heading">
                  <img alt="" src={`/assets/effects/${featured.effect.iconId}.webp`} />
                  <span>{featured.effect.name}</span>
                </div>
                {featured.remaining !== null && (
                  <span className="hud-feature-time">{formatRemainingTime(featured.remaining)}</span>
                )}
                <p>{featured.effect.description}</p>
              </div>
            )}
          </div>
        </div>

        <div className="hud-party" aria-label="Gruppe">
          {state.groupVisible && state.group.map((member) => (
            <CompactUnit
              key={member.id}
              className="hud-party-member"
              name={member.name}
              portrait={member.portrait}
              hpPercent={member.hpPercent}
              unitKind="party"
              mediaUrls={mediaUrls}
              twitch={member.source === "twitch"}
            />
          ))}
        </div>
        {previewOverlay}
      </div>
    </div>
  );
};
