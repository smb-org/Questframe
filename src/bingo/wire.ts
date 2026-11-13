import { MAX_BINGO_CELL_ID_LENGTH } from "../modules/bingo/contracts/constants";
import {
  type BingoLine,
  type BingoPresentationSettings,
  type BingoUpdateMessage,
} from "../modules/bingo/contracts/schemas";
import { DEFAULT_BINGO_PRESENTATION_SETTINGS } from "../modules/bingo/contracts/presentation-settings";
import {
  isChallengeFontFamily,
  isChallengeFontScale,
  isChallengeSetName,
  isChallengeSurfaceOpacity,
  isChallengeTextEmphasis,
  normalizeChallengeText,
} from "../modules/win-challenges/contracts/predicates";

export type BingoMessage = BingoUpdateMessage | { type: "token_revoked" };

const segmenter = new Intl.Segmenter("de", { granularity: "grapheme" });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  // Objektschlüssel sind eindeutig: gleiche Anzahl plus Teilmenge heißt gleiche Menge.
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const parseBingoPresentationSettings = (input: unknown): BingoPresentationSettings | null => {
  const keys = [
    "backgroundOpacity", "textScale", "fontFamily", "textEmphasis", "ceremonyMode",
    "soundOnLine", "soundOnFullCard", "showTitle", "showBingo",
  ];
  if (!isRecord(input) || !exactKeys(input, keys)) return null;
  if (
    !isChallengeSurfaceOpacity(input.backgroundOpacity)
    || !isChallengeFontScale(input.textScale)
    || !isChallengeFontFamily(input.fontFamily)
    || !isChallengeTextEmphasis(input.textEmphasis)
    || (input.ceremonyMode !== "on" && input.ceremonyMode !== "subtle" && input.ceremonyMode !== "off")
    || typeof input.soundOnLine !== "boolean"
    || typeof input.soundOnFullCard !== "boolean"
    || typeof input.showTitle !== "boolean"
    || typeof input.showBingo !== "boolean"
  ) return null;
  return {
    backgroundOpacity: input.backgroundOpacity,
    textScale: input.textScale,
    fontFamily: input.fontFamily,
    textEmphasis: input.textEmphasis,
    ceremonyMode: input.ceremonyMode,
    soundOnLine: input.soundOnLine,
    soundOnFullCard: input.soundOnFullCard,
    showTitle: input.showTitle,
    showBingo: input.showBingo,
  };
};

const normalizeCellText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = normalizeChallengeText(value);
  const graphemes = [...segmenter.segment(normalized)].length;
  return graphemes >= 1 && graphemes <= 40 && normalized.length <= 160 ? normalized : null;
};

const parseBingoUpdate = (input: unknown): BingoUpdateMessage | null => {
  if (!isRecord(input) || input.type !== "bingo_update") return null;
  const messageKeys = Object.hasOwn(input, "ceremony") ? ["type", "board", "ceremony"] : ["type", "board"];
  if (!exactKeys(input, messageKeys) || !isRecord(input.board)) return null;

  const board = input.board;
  const boardKeys = ["card", "marks", "cardRevision", "markRevision", "generation", "style", "placement", "settingsRevision", "settings"];
  const requiredBoardKeys = ["card", "marks", "cardRevision", "markRevision", "generation", "placement"];
  if (
    !Object.keys(board).every((key) => boardKeys.includes(key))
    || !requiredBoardKeys.every((key) => Object.hasOwn(board, key))
    || !isRecord(board.card)
    || !Array.isArray(board.marks)
    || !isRevision(board.cardRevision)
    || !isRevision(board.markRevision)
    || !isRevision(board.generation)
    || (board.settingsRevision !== undefined && !isRevision(board.settingsRevision))
    || (board.style !== undefined && board.style !== "marker" && board.style !== "broadcast")
    || !isRecord(board.placement)
  ) return null;
  const settings = board.settings === undefined
    ? DEFAULT_BINGO_PRESENTATION_SETTINGS
    : parseBingoPresentationSettings(board.settings);
  if (settings === null) return null;

  const card = board.card;
  if (
    !exactKeys(card, ["title", "size", "cells"])
    || typeof card.title !== "string"
    || (card.size !== 3 && card.size !== 4 && card.size !== 5)
    || !Array.isArray(card.cells)
    || card.cells.length !== card.size * card.size
  ) return null;
  const title = normalizeChallengeText(card.title);
  if (!isChallengeSetName(title)) return null;

  const cellIds = new Set<string>();
  const cells: Array<{ id: string; text: string }> = [];
  for (const cell of card.cells) {
    if (
      !isRecord(cell)
      || !exactKeys(cell, ["id", "text"])
      || typeof cell.id !== "string"
      || cell.id.trim().length < 1
      || cell.id.length > MAX_BINGO_CELL_ID_LENGTH
      || cellIds.has(cell.id)
    ) return null;
    const text = normalizeCellText(cell.text);
    if (text === null) return null;
    cellIds.add(cell.id);
    cells.push({ id: cell.id, text });
  }

  const marks = new Set<string>();
  for (const id of board.marks) {
    if (typeof id !== "string" || !cellIds.has(id) || marks.has(id)) return null;
    marks.add(id);
  }

  const placement = board.placement;
  if (
    !exactKeys(placement, ["x", "y", "scale"])
    || typeof placement.x !== "number" || !Number.isInteger(placement.x) || placement.x < 0 || placement.x > 384
    || typeof placement.y !== "number" || !Number.isInteger(placement.y) || placement.y < 0 || placement.y > 216
    || typeof placement.scale !== "number" || placement.scale < 0.75 || placement.scale > 2
  ) return null;

  let ceremony: BingoUpdateMessage["ceremony"];
  if (Object.hasOwn(input, "ceremony")) {
    if (!isRecord(input.ceremony) || !exactKeys(input.ceremony, ["lines", "fullCard"])) return null;
    if (!Array.isArray(input.ceremony.lines) || typeof input.ceremony.fullCard !== "boolean") return null;
    const lines: BingoLine[] = [];
    for (const line of input.ceremony.lines) {
      if (
        !isRecord(line)
        || !exactKeys(line, ["kind", "index"])
        || (line.kind !== "row" && line.kind !== "col" && line.kind !== "diag")
        || typeof line.index !== "number" || !Number.isInteger(line.index) || line.index < 0 || line.index > 4
        || (line.kind === "diag" && line.index > 1)
      ) return null;
      lines.push({ kind: line.kind, index: line.index });
    }
    ceremony = { lines, fullCard: input.ceremony.fullCard };
  }

  return {
    type: "bingo_update",
    board: {
      card: { title, size: card.size, cells },
      marks: [...marks],
      cardRevision: board.cardRevision,
      markRevision: board.markRevision,
      generation: board.generation,
      settingsRevision: board.settingsRevision === undefined ? 1 : board.settingsRevision,
      settings,
      style: board.style === undefined ? "marker" : board.style,
      placement: { x: placement.x, y: placement.y, scale: placement.scale },
    },
    ...(ceremony === undefined ? {} : { ceremony }),
  };
};

export const parseBingoMessage = (input: unknown): BingoMessage | null => {
  if (!isRecord(input)) return null;
  const record = input;
  if (record.type === "token_revoked") {
    return Object.keys(record).length === 1 ? { type: "token_revoked" } : null;
  }
  return parseBingoUpdate(input);
};
