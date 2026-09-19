import { describe, expect, it } from "vitest";

import { allocateControlKey } from "../../../src/modules/win-challenges/domain/control-keys";

type RandomValues = (bytes: Uint8Array) => void;

const scriptedRandomValues = (values: readonly number[]): RandomValues => {
  let index = 0;
  return (bytes) => {
    for (let offset = 0; offset < bytes.length; offset += 1) {
      const value = values[index];
      if (value === undefined) throw new Error("Zufallsskript ist erschöpft.");
      bytes[offset] = value;
      index += 1;
    }
  };
};

const repeatingRandomValues = (values: readonly number[]): {
  source: RandomValues;
  draws: () => number;
} => {
  let index = 0;
  let drawCount = 0;
  return {
    source: (bytes) => {
      for (let offset = 0; offset < bytes.length; offset += 1) {
        bytes[offset] = values[index % values.length] ?? 0;
        index += 1;
        drawCount += 1;
      }
    },
    draws: () => drawCount,
  };
};

const emptyReservations = (): readonly Set<string>[] => [new Set(), new Set()];

describe("Steuer-Key-Allocator", () => {
  it("erzeugt über viele Läufe vierstellige Keys aus dem erlaubten Alphabet", () => {
    const random = repeatingRandomValues(Array.from({ length: 256 }, (_, value) => value));

    for (let index = 0; index < 1_000; index += 1) {
      const key = allocateControlKey(emptyReservations(), { randomValues: random.source });
      expect(key).toHaveLength(4);
      expect(key).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
      expect(key).not.toMatch(/[0O1IL]/);
    }
  });

  it("überspringt einen bereits persistierten Key", () => {
    const randomValues = scriptedRandomValues([
      0, 0, 0, 0,
      1, 1, 1, 1,
    ]);

    expect(allocateControlKey([
      new Set(["AAAA"]),
      new Set<string>(),
    ], { randomValues })).toBe("BBBB");
  });

  it("überspringt einen pensionierten Key bei der nächsten Vergabe", () => {
    const randomValues = scriptedRandomValues([
      0, 0, 0, 0,
      1, 1, 1, 1,
    ]);

    expect(allocateControlKey([
      new Set<string>(),
      new Set<string>(),
      new Set(["AAAA"]),
    ], { randomValues })).toBe("BBBB");
  });

  it("überspringt einen an ein Geschwister im selben Save vergebenen Key", () => {
    const randomValues = scriptedRandomValues([
      2, 2, 2, 2,
      3, 3, 3, 3,
    ]);

    expect(allocateControlKey([
      new Set<string>(),
      new Set(["CCCC"]),
    ], { randomValues })).toBe("DDDD");
  });

  it("behandelt Keys unabhängig von ihrer Groß- und Kleinschreibung als belegt", () => {
    const randomValues = scriptedRandomValues([
      0, 0, 0, 0,
      1, 1, 1, 1,
    ]);

    expect(allocateControlKey([
      new Set(["aAaA"]),
      new Set<string>(),
    ], { randomValues })).toBe("BBBB");
  });

  it("wirft nach einer begrenzten Zahl erfolgloser Versuche einen klaren Fehler", () => {
    const random = repeatingRandomValues([0]);

    expect(() => allocateControlKey([
      new Set(["AAAA"]),
      new Set<string>(),
    ], {
      randomValues: random.source,
      maxAttempts: 3,
    })).toThrow(/Kein freier Steuer-Key/);
    expect(random.draws()).toBe(12);
  });

  it("verwirft Bias-Bytes und verteilt gleich häufige Bytes gleich auf alle Zeichen", () => {
    const random = repeatingRandomValues([
      ...Array.from({ length: 8 }, (_, value) => 248 + value),
      ...Array.from({ length: 248 }, (_, value) => value),
    ]);
    const observed = new Map<string, number>();

    for (let index = 0; index < 62; index += 1) {
      const key = allocateControlKey(emptyReservations(), { randomValues: random.source });
      for (const character of key) {
        observed.set(character, (observed.get(character) ?? 0) + 1);
      }
    }

    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    expect(Array.from(observed.keys()).sort()).toEqual(Array.from(alphabet).sort());
    for (const character of alphabet) {
      expect(observed.get(character)).toBe(8);
    }
  });
});
