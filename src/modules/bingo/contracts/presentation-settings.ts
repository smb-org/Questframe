export const DEFAULT_BINGO_PRESENTATION_SETTINGS = {
  backgroundOpacity: 100,
  textScale: 1,
  fontFamily: "theme",
  textEmphasis: "auto",
  ceremonyMode: "on",
  soundOnLine: false,
  soundOnFullCard: false,
  showTitle: true,
  showBingo: true,
} as const;

export type BingoPresentationSettings = {
  backgroundOpacity: 0 | 25 | 50 | 75 | 100;
  textScale: number;
  fontFamily: "theme" | "atkinson" | "serif" | "sans" | "mono";
  textEmphasis: "auto" | "strong" | "plain";
  ceremonyMode: "on" | "subtle" | "off";
  soundOnLine: boolean;
  soundOnFullCard: boolean;
  showTitle: boolean;
  showBingo: boolean;
};
