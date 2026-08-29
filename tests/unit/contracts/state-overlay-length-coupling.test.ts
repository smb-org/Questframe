import { describe, expect, it } from "vitest";

import { channelStateSchema, createDefaultState } from "../../../src/shared/contracts/state";
import { parseOverlayState } from "../../../src/overlay/wire";

// Regression test for the worst bug in this project: the server used to bound
// `player.title` (and other free text) only by *grapheme* count, while
// `src/overlay/wire.ts` bounds the very same field by JavaScript string
// length, i.e. UTF-16 code units. Astral-plane characters (most emoji) are
// two UTF-16 code units but a single grapheme, so a title the server happily
// accepted could still be rejected by the overlay's own parser as soon as it
// arrived over the wire -- a state the overlay could never render.
//
// `src/shared/contracts/state.ts` now rejects text that exceeds the maximum
// in EITHER unit, so the two bounds can never disagree again. This test pins
// that invariant directly: "whatever the server accepts, the overlay must be
// able to parse."
describe("player.title length stays in lock-step between the server schema and the overlay parser", () => {
  const actor = { twitchUserId: "12345678901234567890", displayName: "Broadcaster" };
  const base = createDefaultState(actor, "2026-08-29T12:00:00.000Z");

  const graphemeSegmenter = new Intl.Segmenter("de", { granularity: "grapheme" });
  const graphemeLength = (value: string): number => [...graphemeSegmenter.segment(value)].length;

  it("rejects 21 emoji (21 graphemes, 42 UTF-16 code units) even though the grapheme count alone is within bounds", () => {
    const title = "🙂".repeat(21);
    expect(graphemeLength(title)).toBe(21); // 21 graphemes ...
    expect(title.length).toBe(42); // ... but 42 UTF-16 code units.

    const result = channelStateSchema.safeParse({
      ...base,
      player: { ...base.player, title },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a title at exactly the 40 UTF-16 code unit ceiling, and the overlay can parse that same state", () => {
    const title = "🙂".repeat(20);
    expect(title.length).toBe(40);

    const state = channelStateSchema.parse({
      ...base,
      player: { ...base.player, title },
    });

    expect(parseOverlayState(state)).not.toBeNull();
  });
});
