import { useState, type CSSProperties, type ReactNode } from "react";

import type {
  ActiveEffect,
  ChannelState,
  PortraitRef,
} from "../shared/contracts/state";
import { formatRemainingTime, getRemainingSeconds } from "../shared/domain/effects";
import { getHealthTier } from "./health";
import "./hud.css";

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
  const [failed, setFailed] = useState(false);
  const url = portraitUrl(portrait, mediaUrls);
  const initials = portrait.kind === "initials" ? portrait.text : initialsFor(name);
  return url !== null && !failed ? (
    <img
      alt=""
      className="hud-portrait-image"
      draggable={false}
      src={url}
      onError={() => {
        setFailed(true);
      }}
    />
  ) : (
    <span className="hud-portrait-fallback" aria-hidden="true">
      {initials}
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
  const [failed, setFailed] = useState(false);
  return (
    <div className={`hud-effect hud-effect--${effect.kind}`} title={effect.description ?? effect.name}>
      {failed ? (
        <span className="hud-effect-fallback">{effect.kind === "buff" ? "+" : "−"}</span>
      ) : (
        <img
          alt=""
          draggable={false}
          src={`/assets/effects/${effect.iconId}.webp`}
          onError={() => {
            setFailed(true);
          }}
        />
      )}
      <span className="hud-sr-only">{effect.name}</span>
      {effect.stacks !== null && <span className="hud-effect-stacks">{effect.stacks}</span>}
      {remaining !== null && <span className="hud-effect-time">{formatRemainingTime(remaining)}</span>}
    </div>
  );
};

const CompactUnit = ({
  name,
  subtitle,
  portrait,
  hpPercent,
  mediaUrls,
  twitch = false,
  className = "",
}: {
  name: string;
  subtitle?: string | null;
  portrait: PortraitRef;
  hpPercent: number;
  mediaUrls?: ReadonlyMap<string, string> | undefined;
  twitch?: boolean;
  className?: string;
}) => (
  <div className={`hud-compact-unit ${className}`}>
    <div className="hud-compact-portrait">
      <Portrait portrait={portrait} name={name} mediaUrls={mediaUrls} />
    </div>
    <div className="hud-compact-body">
      <div className="hud-compact-name-row">
        <span className="hud-compact-name">{name}</span>
        {twitch && (
          <span className="hud-twitch-mark" aria-label="Twitch-Gast" title="Twitch">
            ◧
          </span>
        )}
      </div>
      {subtitle !== undefined && subtitle !== null && (
        <span className="hud-compact-subtitle">{subtitle}</span>
      )}
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
};

export const HudRenderer = ({
  state,
  nowMilliseconds,
  mediaUrls,
  previewOverlay,
  forceVisible = false,
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
      <div className="hud-stage">
        <section className="hud-player" aria-label={`${state.player.name} Unitframe`}>
          <div className="hud-trail-mark" aria-hidden="true" />
          <div className="hud-player-portrait">
            <Portrait portrait={state.player.portrait} name={state.player.name} mediaUrls={mediaUrls} />
            <span className="hud-level">{state.player.level}</span>
          </div>
          <div className="hud-player-body">
            <div className="hud-player-heading">
              <span className="hud-player-name">{state.player.name}</span>
              {state.player.title !== null && <span className="hud-player-title">{state.player.title}</span>}
            </div>
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
        </section>

        <div className="hud-support-row">
          <div className="hud-left-support">
            <div className="hud-effects" aria-label="Aktive Effekte">
              {visibleEffects.map(({ effect, remaining }) => (
                <EffectIcon key={effect.id} effect={effect} remaining={remaining} />
              ))}
            </div>
            <div className="hud-pet-slot">
              {state.pet !== null && (
                <CompactUnit
                  className="hud-pet"
                  name={state.pet.name}
                  subtitle={state.pet.subtitle}
                  portrait={state.pet.portrait}
                  hpPercent={state.pet.hpPercent}
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
          {state.group.map((member) => (
            <CompactUnit
              key={member.id}
              className="hud-party-member"
              name={member.name}
              portrait={member.portrait}
              hpPercent={member.hpPercent}
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
