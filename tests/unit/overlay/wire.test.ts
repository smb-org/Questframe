import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../../src/shared/contracts/state";
import { parseOverlayMessage, parseOverlayState } from "../../../src/overlay/wire";

describe("lightweight overlay wire boundary", () => {
  const state = createDefaultState(
    { twitchUserId: "123", displayName: "Moderator" },
    "2026-08-29T12:00:00.000Z",
  );

  it("accepts complete schema-v1 snapshots without loading the Admin contract bundle", () => {
    expect(parseOverlayState(state)).toEqual(state);
    expect(parseOverlayMessage({ type: "snapshot", state })).toEqual({ type: "snapshot", state });
    expect(parseOverlayMessage({ type: "token_revoked" })).toEqual({ type: "token_revoked" });
  });

  it("fails closed on malformed schema, unsafe numbers and unknown messages", () => {
    expect(parseOverlayState({ ...state, schemaVersion: 2 })).toBeNull();
    expect(parseOverlayState({ ...state, player: { ...state.player, hpPercent: 101 } })).toBeNull();
    expect(parseOverlayState({ ...state, revision: "1" })).toBeNull();
    expect(parseOverlayMessage({ type: "debug", state })).toBeNull();
  });

  it("accepts every portrait kind, pet, group, effects and committed messages", () => {
    const rich = {
      ...state,
      player: { ...state.player, portrait: { kind: "uploaded" as const, contentHash: "a".repeat(64) } },
      pet: {
        name: "Begleiter",
        subtitle: "Spürhund",
        portrait: { kind: "initials" as const, text: "BE" },
        hpPercent: 90,
      },
      group: [{
        id: "twitch-guest",
        source: "twitch" as const,
        twitchUserId: "999",
        name: "GastTV",
        portrait: { kind: "twitch" as const, userId: "999", url: "https://example.test/gast.png" },
        hpPercent: 80,
      }, {
        id: "manual-guest",
        source: "manual" as const,
        twitchUserId: null,
        name: "Normalo",
        portrait: { kind: "bundled" as const, assetId: "default-avatar" },
        hpPercent: 70,
      }],
      effects: [{
        id: "effect-1",
        catalogId: "buff-gestaerkt",
        kind: "buff" as const,
        name: "Gestärkt",
        description: "Bereit",
        iconId: "buff-gestaerkt",
        stacks: 2,
        expiresAt: "2026-08-29T12:05:00.000Z",
        order: 0,
      }],
      featuredEffectId: "effect-1",
    };
    expect(parseOverlayState(rich)).toEqual(rich);
    expect(parseOverlayMessage({ type: "state_committed", state: rich })).toEqual({
      type: "state_committed",
      state: rich,
    });
  });

  it("rejects malformed top-level, placement, player and resource shapes", () => {
    const invalid = [
      null,
      [],
      { ...state, extra: true },
      { ...state, revision: 0 },
      { ...state, overlayEnabled: "yes" },
      { ...state, themeId: "future" },
      { ...state, placement: null },
      { ...state, placement: { ...state.placement, extra: 1 } },
      { ...state, placement: { ...state.placement, x: -1 } },
      { ...state, placement: { ...state.placement, y: 217 } },
      { ...state, placement: { ...state.placement, scale: "1" } },
      { ...state, placement: { ...state.placement, scale: 0.5 } },
      { ...state, player: null },
      { ...state, player: { ...state.player, name: "" } },
      { ...state, player: { ...state.player, title: 12 } },
      { ...state, player: { ...state.player, level: 0 } },
      { ...state, player: { ...state.player, portrait: { kind: "future" } } },
      { ...state, player: { ...state.player, resource: null } },
      { ...state, player: { ...state.player, resource: { ...state.player.resource, extra: true } } },
      { ...state, player: { ...state.player, resource: { ...state.player.resource, name: "" } } },
      { ...state, player: { ...state.player, resource: { ...state.player.resource, color: "red" } } },
      { ...state, player: { ...state.player, resource: { ...state.player.resource, percent: 101 } } },
    ];
    for (const value of invalid) expect(parseOverlayState(value)).toBeNull();
  });

  it("rejects malformed portraits, support units, effects and audit identity", () => {
    const baseMember = {
      id: "guest",
      source: "manual",
      twitchUserId: null,
      name: "Gast",
      portrait: { kind: "initials", text: "G" },
      hpPercent: 100,
    };
    const baseEffect = {
      id: "effect",
      catalogId: null,
      kind: "debuff",
      name: "Müde",
      description: null,
      iconId: "debuff-muede",
      stacks: null,
      expiresAt: null,
      order: 0,
    };
    const invalid = [
      { ...state, player: { ...state.player, portrait: { kind: "uploaded", contentHash: "bad" } } },
      { ...state, player: { ...state.player, portrait: { kind: "twitch", userId: "x", url: "https://x" } } },
      { ...state, player: { ...state.player, portrait: { kind: "initials", text: "" } } },
      { ...state, pet: { name: "", subtitle: null, portrait: { kind: "initials", text: "C" }, hpPercent: 1 } },
      { ...state, pet: { name: "C", subtitle: 1, portrait: { kind: "initials", text: "C" }, hpPercent: 1 } },
      { ...state, group: "guest" },
      { ...state, group: Array.from({ length: 6 }, (_, index) => ({ ...baseMember, id: String(index) })) },
      { ...state, group: [{ ...baseMember, source: "future" }] },
      { ...state, group: [{ ...baseMember, twitchUserId: 123 }] },
      { ...state, group: [{ ...baseMember, name: "" }] },
      { ...state, group: [{ ...baseMember, hpPercent: -1 }] },
      { ...state, effects: "effect" },
      { ...state, effects: Array.from({ length: 9 }, (_, index) => ({ ...baseEffect, id: String(index), order: index })) },
      { ...state, effects: [{ ...baseEffect, order: 1 }] },
      { ...state, effects: [{ ...baseEffect, expiresAt: "not-time" }] },
      { ...state, featuredEffectId: 123 },
      { ...state, featuredEffectId: "missing" },
      { ...state, updatedAt: "not-time" },
      { ...state, updatedBy: null },
      { ...state, updatedBy: { ...state.updatedBy, twitchUserId: "x" } },
      { ...state, updatedBy: { ...state.updatedBy, displayName: "" } },
    ];
    for (const value of invalid) expect(parseOverlayState(value)).toBeNull();
    expect(parseOverlayMessage(null)).toBeNull();
    expect(parseOverlayMessage({ type: 1 })).toBeNull();
    expect(parseOverlayMessage({ type: "token_revoked", extra: true })).toBeNull();
    expect(parseOverlayMessage({ type: "snapshot", state, extra: true })).toBeNull();
    expect(parseOverlayMessage({ type: "snapshot", state: { ...state, revision: 0 } })).toBeNull();
  });
});
