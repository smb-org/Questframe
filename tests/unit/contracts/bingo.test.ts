import { describe, expect, it } from "vitest";

import {
  bingoBoardStateSchema,
  bingoCardSchema,
  bingoCardSaveRequestSchema,
  bingoImportRequestSchema,
  bingoSetLoadRequestSchema,
  bingoSetSaveRequestSchema,
  bingoSetSummarySchema,
  bingoStyleRequestSchema,
  bingoUpdateMessageSchema,
  markCellPayloadSchema,
  resetMarksPayloadSchema,
  type BingoSize,
} from "../../../src/modules/bingo/contracts/schemas";

const card = (size: BingoSize = 3) => ({
  title: "Meine Bingo-Karte",
  size,
  cells: Array.from({ length: size * size }, (_, index) => ({
    id: `cell-${String(index)}`,
    text: `Feld ${String(index)}`,
  })),
});

describe("Bingo-Verträge", () => {
  it("akzeptiert die Kartengrößen 3, 4 und 5 mit genau so vielen Feldern wie Rasterplätze", () => {
    for (const size of [3, 4, 5] as const) {
      expect(bingoCardSchema.safeParse(card(size)).success).toBe(true);
    }
    expect(bingoCardSchema.safeParse({ ...card(3), cells: card(3).cells.slice(0, 8) }).success).toBe(false);
    expect(bingoCardSchema.safeParse({ ...card(3), cells: [...card(3).cells, { id: "extra", text: "Extra" }] }).success).toBe(false);
  });

  it("begrenzt den Karten-Titel wie den Namen eines Challenge-Sets", () => {
    expect(bingoCardSchema.safeParse({ ...card(), title: "x".repeat(24) }).success).toBe(true);
    expect(bingoCardSchema.safeParse({ ...card(), title: "x".repeat(25) }).success).toBe(false);
  });

  it("normalisiert Text und zählt Umlaute sowie typografische Anführungszeichen als einzelne Zeichen", () => {
    const fortyUmlauts = "ä".repeat(40);
    const fortyQuotes = "„“".repeat(20);
    const normalized = bingoCardSchema.parse({
      ...card(),
      title: "  Meine Karte  ",
      cells: card().cells.map((cell, index) => ({
        ...cell,
        text: index === 0 ? `  ${fortyUmlauts}  ` : index === 1 ? fortyQuotes : cell.text,
      })),
    });

    expect(normalized.title).toBe("Meine Karte");
    expect(normalized.cells[0]?.text).toBe(fortyUmlauts);
    expect(normalized.cells[1]?.text).toBe(fortyQuotes);
    expect(bingoCardSchema.safeParse({
      ...card(),
      cells: card().cells.map((cell, index) => ({ ...cell, text: index === 0 ? "ä".repeat(41) : cell.text })),
    }).success).toBe(false);
    expect(bingoCardSchema.safeParse({
      ...card(),
      cells: card().cells.map((cell, index) => ({ ...cell, text: index === 0 ? "„“".repeat(21) : cell.text })),
    }).success).toBe(false);
    expect(bingoCardSchema.safeParse({
      ...card(),
      cells: card().cells.map((cell, index) => ({ ...cell, text: index === 0 ? `${"a".repeat(39)}🔥` : cell.text })),
    }).success).toBe(true);
    expect(bingoCardSchema.safeParse({ ...card(), cells: card().cells.map((cell, index) => ({
      ...cell,
      text: index === 0 ? "   " : cell.text,
    })) }).success).toBe(false);
  });

  it("lehnt doppelte oder leere Feld-IDs ab", () => {
    const duplicate = card();
    duplicate.cells = duplicate.cells.map((cell, index) => index === 1 ? { ...cell, id: "cell-0" } : cell);
    expect(bingoCardSchema.safeParse(duplicate).success).toBe(false);

    const emptyId = card();
    emptyId.cells = emptyId.cells.map((cell, index) => index === 0 ? { ...cell, id: "  " } : cell);
    expect(bingoCardSchema.safeParse(emptyId).success).toBe(false);

    const longId = card();
    longId.cells = longId.cells.map((cell, index) => index === 0 ? { ...cell, id: "x".repeat(41) } : cell);
    expect(bingoCardSchema.safeParse(longId).success).toBe(false);
    const maximumId = card();
    maximumId.cells = maximumId.cells.map((cell, index) => index === 0 ? { ...cell, id: "x".repeat(40) } : cell);
    expect(bingoCardSchema.safeParse(maximumId).success).toBe(true);
  });

  it("gibt beim Board den Marker-Stil vor und prüft Kreuze, IDs und Revisionen", () => {
    const base = {
      card: card(),
      marks: ["cell-0"],
      cardRevision: 0,
      markRevision: 0,
      generation: 0,
      placement: { x: 300, y: 8, scale: 1 },
    };
    expect(bingoBoardStateSchema.parse(base).style).toBe("marker");
    expect(bingoBoardStateSchema.safeParse({ ...base, marks: ["unknown"] }).success).toBe(false);
    expect(bingoBoardStateSchema.safeParse({ ...base, marks: ["cell-0", "cell-0"] }).success).toBe(false);
    expect(bingoBoardStateSchema.safeParse({ ...base, cardRevision: -1 }).success).toBe(false);
    expect(bingoBoardStateSchema.safeParse({ ...base, markRevision: 1.5 }).success).toBe(false);
    expect(bingoBoardStateSchema.safeParse({ ...base, generation: -1 }).success).toBe(false);
    expect(bingoBoardStateSchema.safeParse({ ...base, style: "plain-list" }).success).toBe(false);
  });

  it("validiert Markier-, Reset- und Karten-Speicher-Payloads", () => {
    expect(markCellPayloadSchema.safeParse({ cellId: "cell-1", marked: true, expectedMarkRevision: 0 }).success).toBe(true);
    expect(markCellPayloadSchema.safeParse({ cellId: "", marked: true, expectedMarkRevision: 0 }).success).toBe(false);
    expect(markCellPayloadSchema.safeParse({ cellId: "cell-1", marked: 1, expectedMarkRevision: 0 }).success).toBe(false);
    expect(markCellPayloadSchema.safeParse({ cellId: "cell-1", marked: true, expectedMarkRevision: -1 }).success).toBe(false);
    expect(resetMarksPayloadSchema.safeParse({ expectedMarkRevision: 4 }).success).toBe(true);
    expect(resetMarksPayloadSchema.safeParse({ expectedMarkRevision: 4, marks: [] }).success).toBe(false);
    expect(bingoCardSaveRequestSchema.safeParse({
      ...card(),
      placement: { x: 300, y: 8, scale: 1 },
      expectedCardRevision: 0,
    }).success).toBe(true);
    expect(bingoCardSaveRequestSchema.safeParse({ ...card(), expectedCardRevision: 0 }).success).toBe(false);
    expect(bingoCardSaveRequestSchema.safeParse({ ...card(), expectedCardRevision: 0, marks: [] }).success).toBe(false);
  });

  it("validiert Bingo-Import, Stil- und Set-Routen strikt", () => {
    expect(bingoImportRequestSchema.safeParse({ file: "{}", expectedCardRevision: 0 }).success).toBe(true);
    expect(bingoImportRequestSchema.safeParse({ file: "{}", expectedCardRevision: -1 }).success).toBe(false);
    expect(bingoStyleRequestSchema.safeParse({ style: "broadcast", expectedCardRevision: 0 }).success).toBe(true);
    expect(bingoStyleRequestSchema.safeParse({ style: "broadcast" }).success).toBe(false);
    expect(bingoStyleRequestSchema.safeParse({ style: "future", expectedCardRevision: 0 }).success).toBe(false);
    expect(bingoSetSaveRequestSchema.safeParse({ name: "Vorlage" }).success).toBe(true);
    expect(bingoSetSaveRequestSchema.safeParse({ name: "" }).success).toBe(false);
    expect(bingoSetLoadRequestSchema.safeParse({ expectedCardRevision: 0 }).success).toBe(true);
    expect(bingoSetSummarySchema.safeParse({
      id: "set-id",
      type: "user",
      name: "Vorlage",
      sortOrder: 0,
      createdAt: "2026-11-12T12:00:00.000Z",
      updatedAt: "2026-11-12T12:00:00.000Z",
    }).success).toBe(true);
  });

  it("validiert die bingo_update-Nachricht samt optionaler Zeremonie", () => {
    const board = bingoBoardStateSchema.parse({
      card: card(),
      marks: [],
      cardRevision: 0,
      markRevision: 0,
      generation: 0,
      placement: { x: 300, y: 8, scale: 1 },
    });
    expect(bingoUpdateMessageSchema.safeParse({ type: "bingo_update", board }).success).toBe(true);
    expect(bingoUpdateMessageSchema.safeParse({
      type: "bingo_update",
      board,
      ceremony: { lines: [{ kind: "row", index: 1 }], fullCard: false },
    }).success).toBe(true);
    expect(bingoUpdateMessageSchema.safeParse({
      type: "bingo_update",
      board,
      ceremony: { lines: [{ kind: "other", index: 1 }], fullCard: false },
    }).success).toBe(false);
  });
});
