import type { ChallengeStyleId } from "../shared/contracts/win-challenges";

type StyleImport = () => Promise<unknown>;

/* Jeder Aufbau ist ein eigener Einstiegspunkt; der Budget-Checker misst sie einzeln. */
const STYLE_IMPORTS: Record<ChallengeStyleId, StyleImport> = {
  "plain-list": () => import("../modules/win-challenges/styles/plain-list"),
  "plain-bullets": () => import("../modules/win-challenges/styles/plain-bullets"),
  "plain-numbered": () => import("../modules/win-challenges/styles/plain-numbered"),
  "quest-log": () => import("../modules/win-challenges/styles/quest-log"),
};

export type ChallengeStyleLoader = (styleId: ChallengeStyleId) => Promise<void>;

export const loadChallengeStyle: ChallengeStyleLoader = async (styleId) => {
  await STYLE_IMPORTS[styleId]();
};
