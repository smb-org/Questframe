import { describe, expect, it } from "vitest";

import {
  channelStateDraftSchema,
  channelStateSchema,
  createDefaultState,
  getReleaseCapabilities,
  normalizeStateForRead,
  stateByteLength,
  validateDraftForRelease,
} from "../../../src/shared/contracts/state";

const actor = {
  twitchUserId: "12345678901234567890",
  displayName: "Broadcaster",
};

describe("channel state contract", () => {
  it("creates the canonical schema-v1 state with dormant V1b fields", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");

    expect(channelStateSchema.parse(state)).toEqual(state);
    expect(state).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      overlayEnabled: true,
      themeId: "trail-wood",
      player: {
        name: "Streamer",
        title: "IRL-Abenteuer",
        level: 30,
        portrait: { kind: "initials", text: "ST" },
        hpPercent: 100,
        resource: { name: "Energie", percent: 0, color: "#FFFF00" },
      },
      pet: null,
      petVisible: true,
      group: [],
      groupVisible: true,
      effects: [],
      featuredEffectId: null,
      updatedBy: actor,
    });
  });

  it("defaults section visibility for persisted states from before the flags existed", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const {
      petVisible: _petVisible,
      groupVisible: _groupVisible,
      ...legacyStateWithoutFlags
    } = state;
    const {
      revision: _legacyRevision,
      overlayEnabled: _legacyOverlayEnabled,
      updatedAt: _legacyUpdatedAt,
      updatedBy: _legacyUpdatedBy,
      ...legacyDraft
    } = legacyStateWithoutFlags;
    void [
      _petVisible,
      _groupVisible,
      _legacyRevision,
      _legacyOverlayEnabled,
      _legacyUpdatedAt,
      _legacyUpdatedBy,
    ];

    expect(channelStateDraftSchema.parse(legacyDraft)).toMatchObject({
      petVisible: true,
      groupVisible: true,
    });
    expect(channelStateSchema.parse(legacyStateWithoutFlags)).toMatchObject({
      petVisible: true,
      groupVisible: true,
    });
  });

  it("preserves Twitch identifiers beyond JavaScript's safe integer range", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const parsed = channelStateSchema.parse(state);

    expect(parsed.updatedBy.twitchUserId).toBe("12345678901234567890");
  });

  it("accepts HUD scaling through 200 percent and rejects values above it", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");

    expect(channelStateSchema.parse({
      ...state,
      placement: { ...state.placement, scale: 2 },
    }).placement.scale).toBe(2);
    expect(channelStateSchema.safeParse({
      ...state,
      placement: { ...state.placement, scale: 2.01 },
    }).success).toBe(false);
  });

  it("rejects unknown fields and numeric strings", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");

    expect(() => channelStateSchema.parse({ ...state, surprise: true })).toThrow();
    expect(() =>
      channelStateSchema.parse({
        ...state,
        player: { ...state.player, hpPercent: "100" },
      }),
    ).toThrow();
  });

  it("enforces contiguous effect order and a described featured effect", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const invalid = {
      ...state,
      effects: [
        {
          id: "effect-1",
          catalogId: null,
          kind: "buff" as const,
          name: "Gestärkt",
          description: null,
          iconId: "buff-gestaerkt",
          stacks: null,
          expiresAt: null,
          order: 1,
        },
      ],
      featuredEffectId: "effect-1",
    };

    const result = channelStateSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(
        expect.arrayContaining(["effects.0.order", "featuredEffectId"]),
      );
    }
  });

  it("filters expired effects without changing the revision", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const withEffects = channelStateSchema.parse({
      ...state,
      revision: 7,
      effects: [
        {
          id: "old",
          catalogId: "debuff-muede",
          kind: "debuff",
          name: "Müde",
          description: "Zeit für eine Pause.",
          iconId: "debuff-muede",
          stacks: null,
          expiresAt: "2026-08-29T11:59:59.000Z",
          order: 0,
        },
        {
          id: "fresh",
          catalogId: "buff-gestaerkt",
          kind: "buff",
          name: "Gestärkt",
          description: "Bereit für das nächste Abenteuer.",
          iconId: "buff-gestaerkt",
          stacks: null,
          expiresAt: null,
          order: 1,
        },
      ],
      featuredEffectId: "old",
    });

    const normalized = normalizeStateForRead(withEffects, new Date("2026-08-29T12:00:00.000Z"));
    expect(normalized.revision).toBe(7);
    expect(normalized.effects).toEqual([
      expect.objectContaining({ id: "fresh", order: 0 }),
    ]);
    expect(normalized.featuredEffectId).toBeNull();
  });

  it("publishes strict V1a and V1b capability manifests", () => {
    expect(getReleaseCapabilities("v1a")).toEqual({
      phase: "v1a",
      enabledThemes: ["trail-wood"],
      petEditor: false,
      groupEditor: false,
      undo: false,
    });
    expect(getReleaseCapabilities("v1b")).toEqual({
      phase: "v1b",
      enabledThemes: [
        "trail-wood",
        "field-journal",
        "forged-compass",
        "classic-simple",
        "modern-compact",
        "modern-minimal",
      ],
      petEditor: true,
      groupEditor: true,
      undo: true,
    });
  });

  it("migrates the legacy classic-remix theme id to the wood variant", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");

    expect(channelStateSchema.parse({ ...state, themeId: "classic-remix" }).themeId).toBe(
      "trail-wood",
    );
    expect(() => channelStateSchema.parse({ ...state, themeId: "nope" })).toThrow();
  });

  it("rejects V1b state fields when the server is in V1a", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const {
      revision: _revision,
      overlayEnabled: _overlayEnabled,
      updatedAt: _updatedAt,
      updatedBy: _updatedBy,
      ...draftFields
    } = state;
    expect([_revision, _overlayEnabled, _updatedAt, _updatedBy]).toHaveLength(4);
    const draft = channelStateDraftSchema.parse({
      ...draftFields,
      themeId: "modern-compact",
      pet: {
        name: "Begleiter",
        subtitle: null,
        portrait: { kind: "initials", text: "BE" },
        hpPercent: 100,
      },
    });

    expect(() => validateDraftForRelease(draft, "v1a")).toThrow(/V1a/);
    expect(validateDraftForRelease(draft, "v1b")).toEqual(draft);
  });

  it("normalizes Unicode and enforces group identity/source invariants", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const baseMember = {
      id: "same",
      source: "manual" as const,
      twitchUserId: null,
      name: "  Ga\u0308st  ",
      portrait: { kind: "initials" as const, text: "G" },
      hpPercent: 100,
    };
    const normalized = channelStateSchema.parse({ ...state, group: [baseMember] });
    expect(normalized.group[0]?.name).toBe("Gäst");

    const invalidGroups = [
      [baseMember, { ...baseMember }],
      [{ ...baseMember, source: "twitch", twitchUserId: null }],
      [{ ...baseMember, twitchUserId: "123" }],
      [{ ...baseMember, portrait: { kind: "twitch", userId: "123", url: "https://example.test/a.png" } }],
    ];
    for (const group of invalidGroups) {
      expect(channelStateSchema.safeParse({ ...state, group }).success).toBe(false);
    }
  });

  it("enforces unique effect IDs and retains a valid featured description", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const effect = {
      id: "effect",
      catalogId: null,
      kind: "buff" as const,
      name: "Gestärkt",
      description: "Sichtbar",
      iconId: "buff-gestaerkt",
      stacks: 2,
      expiresAt: null,
      order: 0,
    };
    expect(channelStateSchema.safeParse({
      ...state,
      effects: [effect, { ...effect, order: 1 }],
    }).success).toBe(false);

    const valid = channelStateSchema.parse({
      ...state,
      effects: [effect],
      featuredEffectId: effect.id,
    });
    expect(normalizeStateForRead(valid).featuredEffectId).toBe(effect.id);
    expect(stateByteLength(valid)).toBe(new TextEncoder().encode(JSON.stringify(valid)).byteLength);
  });

  it("rejects empty/overlong grapheme text and every isolated V1a-only violation", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const { revision, overlayEnabled, updatedAt, updatedBy, ...draft } = state;
    expect([revision, overlayEnabled, updatedAt, updatedBy]).toHaveLength(4);
    expect(() => channelStateSchema.parse({ ...state, player: { ...state.player, name: "   " } })).toThrow();
    expect(() => channelStateSchema.parse({ ...state, player: { ...state.player, name: "🙂".repeat(33) } })).toThrow();

    expect(() => validateDraftForRelease({ ...draft, themeId: "modern-minimal" }, "v1a")).toThrow();
    expect(() => validateDraftForRelease({ ...draft, pet: {
      name: "Begleiter",
      subtitle: null,
      portrait: { kind: "initials", text: "BE" },
      hpPercent: 100,
    } }, "v1a")).toThrow();
    expect(() => validateDraftForRelease({ ...draft, group: [{
      id: "guest",
      source: "manual",
      twitchUserId: null,
      name: "Gast",
      portrait: { kind: "initials", text: "G" },
      hpPercent: 100,
    }] }, "v1a")).toThrow();
    expect(validateDraftForRelease(draft, "v1a")).toEqual(draft);
  });
});
