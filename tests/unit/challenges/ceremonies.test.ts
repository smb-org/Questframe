import { describe, expect, it } from "vitest";

import { ceremonyFor } from "../../../src/challenges/ceremonies";

describe("Challenge-Zeremonien", () => {
  it.each(["plain-list", "plain-bullets", "quest-log"] as const)(
    "%s bildet streak-reset auf lost mit dem neutralen Tick-Ton ab",
    (styleId) => {
      expect(ceremonyFor(styleId, {
        scope: "challenge",
        type: "streak-reset",
        challengeId: "challenge-1",
      })).toEqual({
        visual: "lost",
        sound: "tick",
        durationMs: 520,
        eventType: "streak-reset",
        target: { kind: "challenge", id: "challenge-1" },
      });
    },
  );
});
