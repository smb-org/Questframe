import { describe, expect, it } from "vitest";

import { bingoCeremonyFor } from "../../../src/bingo/ceremonies";
import { parseBingoMessage } from "../../../src/bingo/wire";
import type { BingoUpdateMessage } from "../../../src/modules/bingo/contracts/schemas";

const board = {
  card: {
    title: "Testkarte",
    size: 3,
    cells: Array.from({ length: 9 }, (_, index) => ({ id: `c${String(index)}`, text: `Feld ${String(index)}` })),
  },
  marks: ["c0", "c4", "c8"],
  cardRevision: 2,
  markRevision: 5,
  generation: 1,
  style: "marker",
  placement: { x: 0, y: 0, scale: 1 },
};

describe("Bingo-Overlay-Wire", () => {
  it("erfindet beim Snapshot trotz bereits vollendeter Diagonale keine Zeremonie", () => {
    const parsed = parseBingoMessage({ type: "bingo_update", board });

    expect(parsed).not.toBeNull();
    expect(bingoCeremonyFor("marker", parsed as BingoUpdateMessage)).toBeNull();
  });

  it("nimmt die Zeremonie ausschließlich aus dem Update-Payload und priorisiert die Vollkarte", () => {
    const parsed = parseBingoMessage({
      type: "bingo_update",
      board,
      ceremony: { lines: [{ kind: "diag", index: 0 }], fullCard: true },
    });

    expect(parsed).not.toBeNull();
    expect(bingoCeremonyFor("marker", parsed as BingoUpdateMessage)?.type).toBe("full-card");
  });

  it("ignoriert fehlerhafte Nachrichten", () => {
    expect(parseBingoMessage({ type: "bingo_update", board: { ...board, marks: ["unknown"] } })).toBeNull();
  });
});
