import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  decodeBingoCard,
  decodeBingoTemplates,
  encodeBingoCard,
  MAX_BINGO_FILE_BYTES,
} from "../../../src/modules/bingo/domain/card-codec";
import type { BingoCard, BingoSize } from "../../../src/modules/bingo/contracts/schemas";

const card = (size: BingoSize): BingoCard => ({
  title: `Karte ${String(size)}`,
  size,
  cells: Array.from({ length: size * size }, (_, index) => ({
    id: `cell-${String(index)}`,
    text: `Feld ${String(index)}`,
  })),
});

describe("Bingo-Dateicodec", () => {
  it.each([3, 4, 5] as const)("exportiert und importiert eine Karte der Größe %i", (size) => {
    const exported = encodeBingoCard(card(size));
    const envelope = JSON.parse(exported) as Record<string, unknown>;

    expect(envelope).toMatchObject({ format: "questframe-bingo", version: 1 });
    expect(envelope.card).toEqual(card(size));
    expect(exported).toContain("\n  \"format\"");
    expect(decodeBingoCard(exported)).toEqual({ ok: true, value: card(size) });
  });

  it("exportiert keine Zustandsdaten oder zusätzlichen Schlüssel", () => {
    const withRuntimeFields = {
      ...card(3),
      marks: ["cell-0"],
      cardRevision: 8,
      markRevision: 9,
      generation: 2,
      style: "broadcast",
    };
    const envelope = JSON.parse(encodeBingoCard(withRuntimeFields)) as {
      card: Record<string, unknown>;
    };

    expect(Object.keys(envelope.card).sort()).toEqual(["cells", "size", "title"]);
    expect(envelope.card.cells).toEqual(card(3).cells);
  });

  it("liefert kurze deutsche Fehler für zu große und ungültige JSON-Dateien", () => {
    const oversized = decodeBingoCard("x".repeat(MAX_BINGO_FILE_BYTES + 1));
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.error.code).toBe("too-large");
      expect(oversized.error.message).toContain("zu groß");
    }

    const invalidJson = decodeBingoCard("{");
    expect(invalidJson.ok).toBe(false);
    if (!invalidJson.ok) {
      expect(invalidJson.error.code).toBe("invalid-json");
      expect(invalidJson.error.message).toContain("JSON");
    }
  });

  it("weist falsches Format und nicht unterstützte Versionen zurück", () => {
    const valid = JSON.parse(encodeBingoCard(card(3))) as Record<string, unknown>;
    expect(decodeBingoCard(JSON.stringify({ ...valid, format: "wrong" }))).toMatchObject({
      ok: false,
      error: { code: "invalid-schema" },
    });
    expect(decodeBingoCard(JSON.stringify({ ...valid, version: 2 }))).toMatchObject({
      ok: false,
      error: { code: "unsupported-version" },
    });
  });

  it("weist falsche Feldzahl, ungültigen Text, doppelte IDs und Zusatzschlüssel zurück", () => {
    const valid = JSON.parse(encodeBingoCard(card(3))) as {
      format: string;
      version: number;
      card: Record<string, unknown> & { cells: Array<Record<string, unknown>> };
    };
    const cases = [
      { ...valid, card: { ...valid.card, cells: valid.card.cells.slice(0, 8) } },
      { ...valid, card: { ...valid.card, cells: valid.card.cells.map((cell, index) => ({ ...cell, text: index === 0 ? " " : cell.text })) } },
      { ...valid, card: { ...valid.card, cells: valid.card.cells.map((cell, index) => ({ ...cell, id: index === 1 ? valid.card.cells[0]?.id : cell.id })) } },
      { ...valid, extra: true },
      { ...valid, card: { ...valid.card, cells: valid.card.cells.map((cell, index) => ({ ...cell, extra: index === 0 ? true : undefined })) } },
    ];
    for (const value of cases) {
      expect(decodeBingoCard(JSON.stringify(value)).ok).toBe(false);
    }
  });

  it("dekodiert die vier freigegebenen Vorlagen aus der echten Vorlagendatei", () => {
    const text = readFileSync(resolve(process.cwd(), "docs/designs/bingo-vorlagen.json"), "utf8");
    const result = decodeBingoTemplates(text);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toHaveLength(4);
    expect(result.value.every((template) => template.size === 4 && template.cells.length === 16)).toBe(true);
  });

  it("weist falsches Vorlagenformat zurück", () => {
    expect(decodeBingoTemplates(JSON.stringify({
      format: "wrong",
      version: 1,
      sets: [card(3)],
    })).ok).toBe(false);
  });

  it("weist nicht unterstützte Vorlagen-Versionen und unbekannte Schlüssel zurück", () => {
    const templates = { format: "questframe-bingo-vorlagen", version: 1, sets: [card(3)] };
    expect(decodeBingoTemplates(JSON.stringify({ ...templates, version: 2 }))).toMatchObject({
      ok: false,
      error: { code: "unsupported-version" },
    });
    expect(decodeBingoTemplates(JSON.stringify({ ...templates, extra: true })).ok).toBe(false);
  });
});
