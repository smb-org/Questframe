import { describe, expect, it } from "vitest";

import { completedLineCellIds } from "../../../src/modules/bingo/domain/lines";

describe("Bingo-Linienanzeige", () => {
  it("leitet alle Zellen der aktuell vollständigen Linien aus den Kreuzen ab", () => {
    const cells = Array.from({ length: 9 }, (_, index) => `c${String(index)}`);

    expect(completedLineCellIds(["c0", "c1", "c2", "c4", "c8"], cells, 3)).toEqual([
      "c0", "c1", "c2", "c4", "c8",
    ]);
  });

  it("markiert nach dem Entfernen eines Kreuzes keine unvollständige Linie", () => {
    const cells = Array.from({ length: 9 }, (_, index) => `c${String(index)}`);

    expect(completedLineCellIds(["c0", "c1"], cells, 3)).toEqual([]);
  });
});
