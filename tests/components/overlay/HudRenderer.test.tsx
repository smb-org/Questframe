import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createDefaultState, twitchUserIdSchema } from "../../../src/shared/contracts/state";
import { HudRenderer } from "../../../src/overlay/HudRenderer";
import { getHealthTier } from "../../../src/overlay/health";

const actor = { twitchUserId: "123", displayName: "Moderator" };

describe("HUD renderer", () => {
  it("uses the exact requested health thresholds", () => {
    expect(getHealthTier(100)).toBe("healthy");
    expect(getHealthTier(50)).toBe("healthy");
    expect(getHealthTier(49)).toBe("warning");
    expect(getHealthTier(20)).toBe("warning");
    expect(getHealthTier(19)).toBe("critical");
  });

  it("renders player identity, configurable resource, pet, guests and effects compactly", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    render(
      <HudRenderer
        nowMilliseconds={Date.parse("2026-08-29T12:00:00.000Z")}
        state={{
          ...state,
          player: {
            ...state.player,
            hpPercent: 19,
            resource: { name: "Wut", color: "#C2410C", percent: 72 },
          },
          pet: {
            name: "Begleiter",
            subtitle: null,
            portrait: { kind: "initials", text: "BE" },
            hpPercent: 88,
          },
          group: [
            {
              id: "guest-1",
              source: "twitch",
              twitchUserId: twitchUserIdSchema.parse("999"),
              name: "GastTV",
              portrait: {
                kind: "twitch",
                userId: twitchUserIdSchema.parse("999"),
                url: "https://example.test/gast.png",
              },
              hpPercent: 66,
            },
            {
              id: "guest-2",
              source: "manual",
              twitchUserId: null,
              name: "Gast 2",
              portrait: { kind: "bundled", assetId: "default-avatar" },
              hpPercent: 74,
            },
          ],
          effects: [
            {
              id: "effect-1",
              catalogId: "buff-gestaerkt",
              kind: "buff",
              name: "Gestärkt",
              description: "Bereit für das nächste Abenteuer.",
              iconId: "buff-gestaerkt",
              stacks: null,
              expiresAt: "2026-08-29T12:05:00.000Z",
              order: 0,
            },
          ],
          featuredEffectId: "effect-1",
        }}
      />,
    );

    expect(screen.getByText("Streamer")).toBeInTheDocument();
    expect(screen.getByText("IRL-Abenteuer")).toBeInTheDocument();
    expect(screen.getByText("Begleiter")).toBeInTheDocument();
    expect(screen.getByText("GastTV")).toBeInTheDocument();
    expect(screen.getByText("Gast 2")).toBeInTheDocument();
    expect(screen.getAllByText("Gestärkt")).toHaveLength(2);
    expect(screen.getAllByText("5:00")).toHaveLength(2);
    expect(screen.getByTestId("player-health")).toHaveAttribute("data-health-tier", "critical");
    expect(screen.getByLabelText("Wut 72 Prozent")).toBeInTheDocument();
    expect(screen.getByLabelText("Twitch-Gast")).toBeInTheDocument();
  });

  it("is fully transparent when disabled and hides locally expired effects", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const { container, rerender } = render(<HudRenderer state={{ ...state, overlayEnabled: false }} />);
    expect(container.firstChild).toBeNull();

    rerender(
      <HudRenderer
        nowMilliseconds={Date.parse("2026-08-29T12:00:00.000Z")}
        state={{
          ...state,
          effects: [
            {
              id: "expired",
              catalogId: "debuff-muede",
              kind: "debuff",
              name: "Müde",
              description: null,
              iconId: "debuff-muede",
              stacks: null,
              expiresAt: "2026-08-29T11:59:59.000Z",
              order: 0,
            },
          ],
        }}
      />,
    );
    expect(screen.queryByText("Müde")).not.toBeInTheDocument();
  });

  it("falls back to initials when a portrait image fails, and recovers once a new source is set", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const { container, rerender } = render(
      <HudRenderer
        state={{
          ...state,
          player: {
            ...state.player,
            name: "Alex Bergsteiger",
            portrait: { kind: "twitch", userId: twitchUserIdSchema.parse("999"), url: "https://example.test/broken.png" },
          },
        }}
      />,
    );

    const image = container.querySelector("img.hud-portrait-image");
    expect(image).not.toBeNull();
    expect(screen.queryByText("AB")).not.toBeInTheDocument();

    fireEvent.error(image as HTMLImageElement);
    expect(container.querySelector("img.hud-portrait-image")).toBeNull();
    expect(screen.getByText("AB")).toBeInTheDocument();

    // Der Bug: ein NEUES Portrait wurde faelschlich weiterhin als "fehlgeschlagen" behandelt,
    // weil nur ein Boolean statt der fehlgeschlagenen URL gemerkt wurde.
    rerender(
      <HudRenderer
        state={{
          ...state,
          player: {
            ...state.player,
            name: "Alex Bergsteiger",
            portrait: { kind: "twitch", userId: twitchUserIdSchema.parse("999"), url: "https://example.test/new.png" },
          },
        }}
      />,
    );
    expect(screen.queryByText("AB")).not.toBeInTheDocument();
    const recoveredImage = container.querySelector("img.hud-portrait-image");
    expect(recoveredImage).not.toBeNull();
    expect(recoveredImage).toHaveAttribute("src", "https://example.test/new.png");
  });

  it("falls back to a +/- glyph when an effect icon fails to load, and recovers for a different icon", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const { container, rerender } = render(
      <HudRenderer
        nowMilliseconds={Date.parse("2026-08-29T12:00:00.000Z")}
        state={{
          ...state,
          effects: [{
            id: "effect-1",
            catalogId: "buff-gestaerkt",
            kind: "buff",
            name: "Gestärkt",
            description: null,
            iconId: "buff-gestaerkt",
            stacks: null,
            expiresAt: null,
            order: 0,
          }],
        }}
      />,
    );

    const icon = container.querySelector(".hud-effect img");
    expect(icon).not.toBeNull();
    fireEvent.error(icon as HTMLImageElement);
    expect(container.querySelector(".hud-effect img")).toBeNull();
    expect(container.querySelector(".hud-effect-fallback")?.textContent).toBe("+");

    rerender(
      <HudRenderer
        nowMilliseconds={Date.parse("2026-08-29T12:00:00.000Z")}
        state={{
          ...state,
          effects: [{
            id: "effect-2",
            catalogId: "debuff-muede",
            kind: "debuff",
            name: "Müde",
            description: null,
            iconId: "debuff-muede",
            stacks: null,
            expiresAt: null,
            order: 0,
          }],
        }}
      />,
    );
    expect(container.querySelector(".hud-effect-fallback")).toBeNull();
    const recoveredIcon = container.querySelector(".hud-effect img");
    expect(recoveredIcon).toHaveAttribute("src", "/assets/effects/debuff-muede.webp");
  });
});
