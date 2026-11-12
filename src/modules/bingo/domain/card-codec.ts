import { z } from "zod";

import {
  bingoCardSchema,
  type BingoCard,
} from "../contracts/schemas";

export const MAX_BINGO_FILE_BYTES = 32 * 1024;

export type BingoFileDecodeErrorCode = "too-large" | "invalid-json" | "invalid-schema" | "unsupported-version";

export type BingoFileDecodeError = {
  code: BingoFileDecodeErrorCode;
  message: string;
};

export type BingoDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: BingoFileDecodeError };

const bingoCardFileSchema = z.strictObject({
  format: z.literal("questframe-bingo"),
  version: z.literal(1),
  card: bingoCardSchema,
});

const bingoTemplatesFileSchema = z.strictObject({
  format: z.literal("questframe-bingo-vorlagen"),
  version: z.literal(1),
  sets: z.array(bingoCardSchema),
});

const parseJson = (text: string): BingoDecodeResult<unknown> => {
  if (new TextEncoder().encode(text).byteLength > MAX_BINGO_FILE_BYTES) {
    return { ok: false, error: { code: "too-large", message: "Datei ist zu groß (maximal 32 KiB)." } };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: { code: "invalid-json", message: "JSON ist ungültig." } };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidFile = (message: string): BingoDecodeResult<never> => ({
  ok: false,
  error: { code: "invalid-schema", message },
});

const unsupportedVersion = (message: string): BingoDecodeResult<never> => ({
  ok: false,
  error: { code: "unsupported-version", message },
});

/** Exportiert ausschließlich die portable Karte, niemals Laufzeit-Zustand. */
export const encodeBingoCard = (card: BingoCard): string => {
  const portableCard = bingoCardSchema.parse({
    title: card.title,
    size: card.size,
    cells: card.cells.map(({ id, text }) => ({ id, text })),
  });
  return JSON.stringify({
    format: "questframe-bingo",
    version: 1,
    card: portableCard,
  }, null, 2);
};

export const decodeBingoCard = (text: string): BingoDecodeResult<BingoCard> => {
  const json = parseJson(text);
  if (!json.ok) return json;
  if (isRecord(json.value) && json.value.version !== undefined && json.value.version !== 1) {
    return unsupportedVersion("Bingo-Version wird nicht unterstützt; erwartet wird Version 1.");
  }
  if (isRecord(json.value) && json.value.format !== "questframe-bingo") {
    return invalidFile("Datei hat kein gültiges Bingo-Format.");
  }

  const parsed = bingoCardFileSchema.safeParse(json.value);
  if (!parsed.success) return invalidFile("Datei enthält keine gültige Bingo-Karte.");
  return { ok: true, value: parsed.data.card };
};

export const decodeBingoTemplates = (text: string): BingoDecodeResult<BingoCard[]> => {
  const json = parseJson(text);
  if (!json.ok) return json;
  if (isRecord(json.value) && json.value.version !== undefined && json.value.version !== 1) {
    return unsupportedVersion("Vorlagen-Version wird nicht unterstützt; erwartet wird Version 1.");
  }
  if (isRecord(json.value) && json.value.format !== "questframe-bingo-vorlagen") {
    return invalidFile("Datei hat kein gültiges Vorlagenformat.");
  }

  const parsed = bingoTemplatesFileSchema.safeParse(json.value);
  if (!parsed.success) return invalidFile("Vorlagendatei enthält ungültige Karten.");
  return { ok: true, value: parsed.data.sets };
};
