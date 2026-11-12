import { parseOverlayMessage } from "../overlay/wire";
import { isStateBearingMessage } from "../overlay/message-policy";
import { parseChallengeMessage } from "../challenges/wire";
import { isChallengeSetName, normalizeChallengeText } from "../modules/win-challenges/contracts/predicates";
import type { BingoUpdateMessage } from "../modules/bingo/contracts/schemas";

type ParsedOverlayMessage = Extract<
  NonNullable<ReturnType<typeof parseOverlayMessage>>,
  { type: "snapshot" | "state_committed" }
>;
type ParsedChallengeMessage = NonNullable<ReturnType<typeof parseChallengeMessage>>;
type ParsedBingoMessage = BingoUpdateMessage;

export type CompositeDiscrimination =
  | { kind: "hud"; message: ParsedOverlayMessage | null }
  | { kind: "challenges"; message: ParsedChallengeMessage | null }
  | { kind: "bingo"; message: ParsedBingoMessage | null }
  | { kind: "token_revoked"; message: { type: "token_revoked" } | null }
  | { kind: "ignore" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const present = Object.keys(value).sort();
  const expected = [...keys].sort();
  return present.length === expected.length && present.every((key, index) => key === expected[index]);
};

const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const bingoTextSegmenter = new Intl.Segmenter("de", { granularity: "grapheme" });

const isBingoCellText = (value: unknown): value is string => {
  if (typeof value !== "string" || value !== normalizeChallengeText(value) || value.length > 160) return false;
  const graphemeCount = [...bingoTextSegmenter.segment(value)].length;
  return graphemeCount >= 1 && graphemeCount <= 40;
};

const parseBingoUpdateMessage = (input: unknown): ParsedBingoMessage | null => {
  if (!isRecord(input) || input.type !== "bingo_update") return null;
  const messageKeys = Object.hasOwn(input, "ceremony")
    ? ["type", "board", "ceremony"]
    : ["type", "board"];
  if (!exactKeys(input, messageKeys) || !isRecord(input.board)) return null;

  const board = input.board;
  const boardKeys = Object.hasOwn(board, "style")
    ? ["card", "marks", "cardRevision", "markRevision", "generation", "style", "placement"]
    : ["card", "marks", "cardRevision", "markRevision", "generation", "placement"];
  if (
    !exactKeys(board, boardKeys) ||
    !isRecord(board.card) ||
    !Array.isArray(board.marks) ||
    !isRevision(board.cardRevision) ||
    !isRevision(board.markRevision) ||
    !isRevision(board.generation) ||
    (board.style !== undefined && board.style !== "marker" && board.style !== "broadcast") ||
    !isRecord(board.placement)
  ) return null;

  const card = board.card;
  if (
    !exactKeys(card, ["title", "size", "cells"]) ||
    !isChallengeSetName(card.title) ||
    (card.size !== 3 && card.size !== 4 && card.size !== 5) ||
    !Array.isArray(card.cells) || card.cells.length !== card.size * card.size
  ) return null;

  const cellIds = new Set<string>();
  for (const cell of card.cells) {
    if (
      !isRecord(cell) ||
      !exactKeys(cell, ["id", "text"]) ||
      typeof cell.id !== "string" || cell.id.trim().length < 1 || cell.id.length > 80 ||
      !isBingoCellText(cell.text) ||
      cellIds.has(cell.id)
    ) return null;
    cellIds.add(cell.id);
  }
  const markedIds = new Set<string>();
  for (const id of board.marks) {
    if (typeof id !== "string" || !cellIds.has(id) || markedIds.has(id)) return null;
    markedIds.add(id);
  }

  const placement = board.placement;
  if (
    !exactKeys(placement, ["x", "y", "scale"]) ||
    typeof placement.x !== "number" || !Number.isInteger(placement.x) || placement.x < 0 || placement.x > 384 ||
    typeof placement.y !== "number" || !Number.isInteger(placement.y) || placement.y < 0 || placement.y > 216 ||
    typeof placement.scale !== "number" || placement.scale < 0.75 || placement.scale > 2
  ) return null;

  if (Object.hasOwn(input, "ceremony")) {
    if (!isRecord(input.ceremony) || !exactKeys(input.ceremony, ["lines", "fullCard"])) return null;
    if (!Array.isArray(input.ceremony.lines) || typeof input.ceremony.fullCard !== "boolean") return null;
    for (const line of input.ceremony.lines) {
      if (
        !isRecord(line) ||
        !exactKeys(line, ["kind", "index"]) ||
        (line.kind !== "row" && line.kind !== "col" && line.kind !== "diag") ||
        typeof line.index !== "number" || !Number.isInteger(line.index) || line.index < 0 || line.index > 4 ||
        (line.kind === "diag" && line.index > 1)
      ) return null;
    }
  }

  const normalizedBoard = board.style === undefined ? { ...board, style: "marker" } : board;
  return { ...input, board: normalizedBoard } as unknown as ParsedBingoMessage;
};

const parseHudMessage = (input: unknown): ParsedOverlayMessage | null => {
  const parsed = parseOverlayMessage(input);
  return parsed !== null && (parsed.type === "snapshot" || parsed.type === "state_committed")
    ? parsed
    : null;
};

export const discriminateCompositeMessage = (input: unknown): CompositeDiscrimination => {
  // Die bestehende Policy ist die einzige Quelle dafür, welche Nachrichten den
  // HUD-Parser adressieren. Sie wird absichtlich nicht dupliziert.
  if (isStateBearingMessage(input)) {
    return { kind: "hud", message: parseHudMessage(input) };
  }
  if (isRecord(input) && input.type === "token_revoked") {
    const parsed = parseOverlayMessage(input);
    return {
      kind: "token_revoked",
      message: parsed?.type === "token_revoked" ? parsed : null,
    };
  }
  if (isRecord(input) && input.type === "bingo_update") {
    return { kind: "bingo", message: parseBingoUpdateMessage(input) };
  }
  if (isRecord(input) && !Object.hasOwn(input, "type") && Object.hasOwn(input, "eventSeq")) {
    const parsed = parseChallengeMessage(input);
    return {
      kind: "challenges",
      message: parsed !== null && "eventSeq" in parsed ? parsed : null,
    };
  }
  return { kind: "ignore" };
};
