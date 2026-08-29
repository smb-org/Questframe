import { describe, expect, it } from "vitest";

import {
  EFFECT_CATALOG,
  formatRemainingTime,
  getEffectDefinition,
  getRemainingSeconds,
  validateEffectExpiries,
} from "../../../src/shared/domain/effects";
import { createDefaultState } from "../../../src/shared/contracts/state";

describe("effect catalog and timers", () => {
  it("contains 20 original buffs and 20 original debuffs with unique ids", () => {
    expect(EFFECT_CATALOG.filter((effect) => effect.kind === "buff")).toHaveLength(20);
    expect(EFFECT_CATALOG.filter((effect) => effect.kind === "debuff")).toHaveLength(20);
    expect(new Set(EFFECT_CATALOG.map((effect) => effect.id)).size).toBe(40);
    expect(EFFECT_CATALOG.map((effect) => effect.name)).toEqual(
      expect.arrayContaining(["Gestärkt", "Satt", "Hungrig", "Müde"]),
    );
    for (const effect of EFFECT_CATALOG) {
      expect(effect.iconId).toBe(effect.id);
      expect(effect.description.length).toBeGreaterThan(0);
      expect(effect.description.length).toBeLessThanOrEqual(90);
    }
  });

  it("counts down from an absolute instant and formats useful labels", () => {
    const now = Date.parse("2026-08-29T12:00:00.000Z");
    expect(getRemainingSeconds("2026-08-29T12:01:01.000Z", now)).toBe(61);
    expect(getRemainingSeconds("2026-08-29T11:59:59.000Z", now)).toBe(0);
    expect(getRemainingSeconds(null, now)).toBeNull();
    expect(formatRemainingTime(null)).toBe("");
    expect(formatRemainingTime(0)).toBe("0:00");
    expect(formatRemainingTime(61)).toBe("1:01");
    expect(formatRemainingTime(3_661)).toBe("1:01:01");
  });

  it("accepts unchanged near-expiry instants but requires new timers to be 1m–30d", () => {
    const actor = { twitchUserId: "123", displayName: "Moderator" };
    const current = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const effect = {
      id: "e1",
      catalogId: "buff-gestaerkt",
      kind: "buff" as const,
      name: "Gestärkt",
      description: "Bereit für das nächste Abenteuer.",
      iconId: "buff-gestaerkt",
      stacks: null,
      expiresAt: "2026-08-29T12:00:30.000Z",
      order: 0,
    };
    const previous = { ...current, effects: [effect] };

    expect(() => {
      validateEffectExpiries([effect], previous.effects, Date.parse("2026-08-29T12:00:00.000Z"));
    }).not.toThrow();
    expect(() => {
      validateEffectExpiries(
        [{ ...effect, expiresAt: "2026-08-29T12:00:31.000Z" }],
        previous.effects,
        Date.parse("2026-08-29T12:00:00.000Z"),
      );
    }).toThrow(/mindestens einer Minute/);
    expect(() => {
      validateEffectExpiries(
        [{ ...effect, id: "e2", expiresAt: "2026-10-01T12:00:00.000Z" }],
        previous.effects,
        Date.parse("2026-08-29T12:00:00.000Z"),
      );
    }).toThrow(/30 Tage/);

    expect(() => {
      validateEffectExpiries(
        [{ ...effect, id: "untimed", expiresAt: null }],
        previous.effects,
        Date.parse("2026-08-29T12:00:00.000Z"),
      );
    }).not.toThrow();
    expect(() => {
      validateEffectExpiries(
        [{ ...effect, id: "valid", expiresAt: "2026-08-30T12:00:00.000Z" }],
        previous.effects,
        Date.parse("2026-08-29T12:00:00.000Z"),
      );
    }).not.toThrow();
  });

  it("resolves catalog entries without inventing custom definitions", () => {
    expect(getEffectDefinition(null)).toBeUndefined();
    expect(getEffectDefinition("missing")).toBeUndefined();
    expect(getEffectDefinition("buff-gestaerkt")).toMatchObject({ name: "Gestärkt", kind: "buff" });
  });
});
