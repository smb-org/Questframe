import type { BingoStyleId } from "../modules/bingo/contracts/schemas";

type StyleImport = () => Promise<{ styleId: BingoStyleId }>;

const STYLE_IMPORTS: Partial<Record<BingoStyleId, StyleImport>> = {
  marker: () => import("../modules/bingo/styles/marker"),
  broadcast: () => import("../modules/bingo/styles/broadcast"),
};

export type BingoStyleLoader = (styleId: BingoStyleId) => Promise<void>;

export const loadBingoStyle: BingoStyleLoader = async (styleId) => {
  const load = STYLE_IMPORTS[styleId];
  if (load === undefined) throw new Error(`Bingo-Stil „${styleId}“ ist nicht verfügbar.`);
  const module = await load();
  if (module.styleId !== styleId) throw new Error(`Bingo-Stil „${styleId}“ wurde nicht korrekt geladen.`);
};
