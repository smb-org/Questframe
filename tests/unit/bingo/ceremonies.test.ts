import { describe, expect, it } from "vitest";

import { bingoCeremonyFor } from "../../../src/bingo/ceremonies";
import type { BingoUpdateMessage } from "../../../src/modules/bingo/contracts/schemas";

const update = (ceremony?: BingoUpdateMessage["ceremony"]): BingoUpdateMessage => ({
  type: "bingo_update",
  board: {
    card: {
      title: "Testkarte",
      size: 3,
      cells: Array.from({ length: 9 }, (_, index) => ({ id: `cell-${String(index)}`, text: `Feld ${String(index + 1)}` })),
    },
    marks: [],
    cardRevision: 1,
    markRevision: 2,
    generation: 0,
    settingsRevision: 1,
    settings: {
      backgroundOpacity: 100, textScale: 1, fontFamily: "theme", textEmphasis: "auto",
      ceremonyMode: "on", soundOnLine: false, soundOnFullCard: false, showTitle: true, showBingo: true,
    },
    style: "broadcast",
    placement: { x: 8, y: 80, scale: 1 },
  },
  ...(ceremony === undefined ? {} : { ceremony }),
});

describe("Bingo-Zeremonien", () => {
  it("startet die Broadcast-Linienzeremonie nur mit Linien aus dem Update", () => {
    expect(bingoCeremonyFor("broadcast", update())).toBeNull();
    const ceremony = bingoCeremonyFor("broadcast", update({ lines: [{ kind: "row", index: 0 }], fullCard: false }));
    expect(ceremony).toMatchObject({ type: "line", lines: [{ kind: "row", index: 0 }] });
    expect(ceremony?.durationMs).toBeGreaterThan(0);
  });

  it("gibt der größeren Broadcast-Vollkartenzeremonie Vorrang", () => {
    const ceremony = bingoCeremonyFor("broadcast", update({ lines: [{ kind: "row", index: 0 }], fullCard: true }));
    const line = bingoCeremonyFor("broadcast", update({ lines: [{ kind: "row", index: 0 }], fullCard: false }));

    expect(ceremony?.type).toBe("full-card");
    expect(ceremony?.durationMs).toBeGreaterThan(line?.durationMs ?? 0);
  });
});
