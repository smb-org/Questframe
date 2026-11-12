import { describe, expect, it } from "vitest";

import { newlyCompleted } from "../../../src/modules/bingo/domain/lines";

const cells = Array.from({ length: 9 }, (_, index) => `c${String(index)}`);

describe("Bingo-Linien", () => {
  it("erkennt eine neu vollendete Reihe", () => {
    expect(newlyCompleted([], ["c0", "c1", "c2"], cells, 3)).toEqual({
      lines: [{ kind: "row", index: 0 }],
      fullCard: false,
    });
  });

  it("erkennt eine neu vollendete Spalte", () => {
    expect(newlyCompleted([], ["c1", "c4", "c7"], cells, 3)).toEqual({
      lines: [{ kind: "col", index: 1 }],
      fullCard: false,
    });
  });

  it("erkennt beide Diagonalen und sortiert Zeilen, Spalten und Diagonalen stabil", () => {
    expect(newlyCompleted([], cells, cells, 3)).toEqual({
      lines: [
        { kind: "row", index: 0 },
        { kind: "row", index: 1 },
        { kind: "row", index: 2 },
        { kind: "col", index: 0 },
        { kind: "col", index: 1 },
        { kind: "col", index: 2 },
        { kind: "diag", index: 0 },
        { kind: "diag", index: 1 },
      ],
      fullCard: true,
    });
  });

  it("meldet zwei Linien, die durch dasselbe neue Kreuz vollendet werden", () => {
    const before = ["c1", "c3", "c5", "c7"];
    expect(newlyCompleted(before, [...before, "c4"], cells, 3)).toEqual({
      lines: [
        { kind: "row", index: 1 },
        { kind: "col", index: 1 },
      ],
      fullCard: false,
    });
  });

  it("markiert die Vollkarte erst beim letzten Kreuz und gibt trotzdem Linien zurück", () => {
    const before = cells.slice(0, 8);
    expect(newlyCompleted(before, cells, cells, 3)).toEqual({
      lines: [
        { kind: "row", index: 2 },
        { kind: "col", index: 2 },
        { kind: "diag", index: 0 },
      ],
      fullCard: true,
    });
  });

  it("liefert beim Abwählen nichts und erkennt dieselbe Linie nach erneutem Ankreuzen", () => {
    const row = ["c0", "c1", "c2"];
    expect(newlyCompleted(row, ["c0", "c1"], cells, 3)).toEqual({ lines: [], fullCard: false });
    expect(newlyCompleted(["c0", "c1"], row, cells, 3)).toEqual({
      lines: [{ kind: "row", index: 0 }],
      fullCard: false,
    });
  });

  it("ignoriert IDs, die nicht zur Karte gehören", () => {
    expect(newlyCompleted(["outside"], ["outside", "c0", "c1", "c2"], cells, 3)).toEqual({
      lines: [{ kind: "row", index: 0 }],
      fullCard: false,
    });
  });
});
