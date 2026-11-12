import { z } from "zod";
import { auditEntrySchema, undoTargetSchema } from "../../../shared/contracts/api";

import {
  isChallengeSetName,
  MAX_CHALLENGE_SET_NAME_GRAPHEMES,
  normalizeChallengeText,
} from "../../win-challenges/contracts/predicates";
import { challengePlacementSchema } from "../../win-challenges/contracts/schemas";
import { MAX_BINGO_CELL_ID_LENGTH } from "./constants";

export { MAX_BINGO_CELL_ID_LENGTH } from "./constants";

export type BingoStyleId = "marker" | "broadcast";

export const bingoSizeSchema = z.union([z.literal(3), z.literal(4), z.literal(5)]);
export type BingoSize = z.infer<typeof bingoSizeSchema>;

export const DEFAULT_BINGO_STYLE_ID: BingoStyleId = "marker";
export const MAX_BINGO_TITLE_LENGTH = MAX_CHALLENGE_SET_NAME_GRAPHEMES;
export const MAX_BINGO_CELL_TEXT_LENGTH = 40;

const graphemeSegmenter = new Intl.Segmenter("de", { granularity: "grapheme" });

const normalizeText = normalizeChallengeText;

const graphemeLength = (value: string): number => [...graphemeSegmenter.segment(value)].length;

const bingoTitleSchema = z.preprocess(
  (value) => typeof value === "string" ? normalizeText(value) : value,
  z.custom<string>(
    (value): value is string => isChallengeSetName(value),
    { message: `Karten-Titel muss 1–${String(MAX_BINGO_TITLE_LENGTH)} Grapheme lang sein.` },
  ),
);

const normalizedTextSchema = (maximum: number, message: string): z.ZodType<string> => z.preprocess(
  (value) => typeof value === "string" ? normalizeText(value) : value,
  z.custom<string>(
    (value): value is string => {
      if (typeof value !== "string") return false;
      const length = graphemeLength(value);
      // Grapheme zählen (Emoji = 1 Zeichen); UTF-16-Deckel nur gegen Riesen-Cluster.
      return length >= 1 && length <= maximum && value.length <= maximum * 4;
    },
    { message },
  ),
);

const bingoCellIdSchema = z.string().refine(
  (value) => value.trim().length > 0 && value.length <= MAX_BINGO_CELL_ID_LENGTH,
  { message: `Feld-ID muss 1–${String(MAX_BINGO_CELL_ID_LENGTH)} Zeichen enthalten.` },
);

const bingoCellObjectSchema = z.strictObject({
  id: bingoCellIdSchema,
  text: normalizedTextSchema(
    MAX_BINGO_CELL_TEXT_LENGTH,
    `Feldtext muss 1–${String(MAX_BINGO_CELL_TEXT_LENGTH)} Zeichen lang sein.`,
  ),
});

const bingoCardFieldsSchema = z.strictObject({
  title: bingoTitleSchema,
  size: bingoSizeSchema,
  cells: z.array(bingoCellObjectSchema),
});

const validateCardCells = (
  value: { size: BingoSize; cells: { id: string }[] },
  context: z.RefinementCtx,
): void => {
  const expected = value.size * value.size;
  if (value.cells.length !== expected) {
    context.addIssue({
      code: "custom",
      path: ["cells"],
      message: `Eine ${String(value.size)}×${String(value.size)}-Karte braucht genau ${String(expected)} Felder.`,
    });
  }

  const ids = new Set<string>();
  value.cells.forEach((cell, index) => {
    if (ids.has(cell.id)) {
      context.addIssue({
        code: "custom",
        path: ["cells", index, "id"],
        message: "Feld-IDs müssen eindeutig sein.",
      });
    }
    ids.add(cell.id);
  });
};

export const bingoCellSchema = bingoCellObjectSchema;

export const bingoCardSchema = bingoCardFieldsSchema.superRefine(validateCardCells);

const nonNegativeIntegerSchema = z.custom<number>(
  (value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
  { message: "Wert muss eine nichtnegative Ganzzahl sein." },
);

export const bingoLineSchema = z.strictObject({
  kind: z.enum(["row", "col", "diag"]),
  index: z.number().int().min(0).max(4),
}).superRefine((line, context) => {
  if (line.kind === "diag" && line.index > 1) {
    context.addIssue({ code: "custom", path: ["index"], message: "Diagonalen-Index ist ungültig." });
  }
});

export const bingoStyleIdSchema = z.enum(["marker", "broadcast"]);

export const markCellPayloadSchema = z.strictObject({
  cellId: bingoCellIdSchema,
  marked: z.boolean(),
  expectedMarkRevision: nonNegativeIntegerSchema,
});

export const resetMarksPayloadSchema = z.strictObject({
  expectedMarkRevision: nonNegativeIntegerSchema,
});

export const bingoCardSaveRequestSchema = bingoCardFieldsSchema.extend({
  placement: challengePlacementSchema,
  expectedCardRevision: nonNegativeIntegerSchema,
}).superRefine((value, context) => {
  validateCardCells(value, context);
});

export const bingoImportRequestSchema = z.strictObject({
  file: z.string().max(32_768),
  expectedCardRevision: nonNegativeIntegerSchema,
});

export const bingoStyleRequestSchema = z.strictObject({
  style: bingoStyleIdSchema,
});

export const bingoSetSaveRequestSchema = z.strictObject({
  name: z.string().min(1).max(MAX_BINGO_TITLE_LENGTH),
});

export const bingoSetLoadRequestSchema = z.strictObject({
  expectedCardRevision: nonNegativeIntegerSchema,
});

export const bingoSetSummarySchema = z.strictObject({
  id: z.string().min(1).max(64),
  type: z.enum(["template", "user"]),
  name: z.string().min(1).max(MAX_BINGO_TITLE_LENGTH),
  sortOrder: z.number().int().min(0),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const bingoSetListResponseSchema = z.strictObject({
  sets: z.array(bingoSetSummarySchema).max(64),
});

export const bingoSetResponseSchema = z.strictObject({
  summary: bingoSetSummarySchema,
  card: bingoCardSchema,
});

export const bingoSetDeleteResponseSchema = z.strictObject({
  id: z.string().min(1).max(64),
  deleted: z.literal(true),
});


export const bingoBoardStateSchema = z.strictObject({
  card: bingoCardSchema,
  marks: z.array(bingoCellIdSchema),
  cardRevision: nonNegativeIntegerSchema,
  markRevision: nonNegativeIntegerSchema,
  generation: nonNegativeIntegerSchema,
  style: bingoStyleIdSchema.default(DEFAULT_BINGO_STYLE_ID),
  placement: challengePlacementSchema,
}).superRefine((board, context) => {
  const cellIds = new Set(board.card.cells.map((cell) => cell.id));
  const markedIds = new Set<string>();
  board.marks.forEach((id, index) => {
    if (!cellIds.has(id)) {
      context.addIssue({
        code: "custom",
        path: ["marks", index],
        message: "Markierung verweist auf ein unbekanntes Feld.",
      });
    }
    if (markedIds.has(id)) {
      context.addIssue({
        code: "custom",
        path: ["marks", index],
        message: "Markierungen dürfen keine Feld-ID doppelt enthalten.",
      });
    }
    markedIds.add(id);
  });
});

export const bingoUpdateMessageSchema = z.strictObject({
  type: z.literal("bingo_update"),
  board: bingoBoardStateSchema,
  ceremony: z.strictObject({
    lines: z.array(bingoLineSchema),
    fullCard: z.boolean(),
  }).optional(),
});

export const bingoUndoResponseSchema = z.strictObject({
  board: bingoBoardStateSchema,
  undoTargets: z.array(undoTargetSchema).max(20),
  serverTime: z.iso.datetime({ offset: true }),
});

export const bingoMutationResponseSchema = z.strictObject({
  board: bingoBoardStateSchema,
  update: z.union([bingoUpdateMessageSchema, z.null()]),
  ceremony: z.union([
    z.strictObject({ lines: z.array(bingoLineSchema), fullCard: z.boolean() }),
    z.null(),
  ]),
  auditEntry: z.union([auditEntrySchema, z.null()]),
  undoTargets: z.array(undoTargetSchema).max(20),
  serverTime: z.iso.datetime({ offset: true }),
});

export type BingoCell = z.infer<typeof bingoCellSchema>;
export type BingoCard = z.infer<typeof bingoCardSchema>;
export type BingoSetListResponse = z.infer<typeof bingoSetListResponseSchema>;
export type BingoSetResponse = z.infer<typeof bingoSetResponseSchema>;
export type BingoLine = z.infer<typeof bingoLineSchema>;
export type BingoBoardState = z.infer<typeof bingoBoardStateSchema>;
export type MarkCellPayload = z.infer<typeof markCellPayloadSchema>;
export type ResetMarksPayload = z.infer<typeof resetMarksPayloadSchema>;
export type BingoCardSaveRequest = z.infer<typeof bingoCardSaveRequestSchema>;
export type BingoSetSummary = z.infer<typeof bingoSetSummarySchema>;
export type BingoUpdateMessage = z.infer<typeof bingoUpdateMessageSchema>;
export type BingoUndoResponse = z.infer<typeof bingoUndoResponseSchema>;
export type BingoMutationResponse = z.infer<typeof bingoMutationResponseSchema>;
