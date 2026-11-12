import type { BingoLine, BingoStyleId, BingoUpdateMessage } from "../modules/bingo/contracts/schemas";

export type BingoCeremony = {
  type: "line" | "full-card";
  lines: BingoLine[];
  durationMs: number;
};

type CeremonyEntry = {
  lineDurationMs: number;
  fullCardDurationMs: number;
};

const CEREMONY_REGISTRY: Partial<Record<BingoStyleId, CeremonyEntry>> = {
  marker: { lineDurationMs: 1_000, fullCardDurationMs: 1_600 },
  broadcast: { lineDurationMs: 1_250, fullCardDurationMs: 2_200 },
};

/** Zeremonien kommen nur aus dem expliziten Update-Payload, nie aus einem Zustandsvergleich. */
export const bingoCeremonyFor = (
  style: BingoStyleId,
  update: BingoUpdateMessage,
): BingoCeremony | null => {
  const payload = update.ceremony;
  const entry = CEREMONY_REGISTRY[style];
  if (payload === undefined || entry === undefined) return null;
  if (payload.fullCard) {
    return { type: "full-card", lines: payload.lines, durationMs: entry.fullCardDurationMs };
  }
  if (payload.lines.length === 0) return null;
  return { type: "line", lines: payload.lines, durationMs: entry.lineDurationMs };
};
