import type { ChallengeThemeId } from "../shared/contracts/win-challenges";

type ThemeImport = () => Promise<unknown>;

/*
 * Die explizite Tabelle ist Absicht: Jede Variante wird als eigener dynamischer
 * Einstiegspunkt gebaut und kann vom Budget-Gate separat gemessen werden.
 */
const THEME_IMPORTS: Record<ChallengeThemeId, ThemeImport> = {
  "trail-wood": () => import("../overlay/themes/trail-wood/theme.css"),
  "field-journal": () => import("../overlay/themes/field-journal/theme.css"),
  "forged-compass": () => import("../overlay/themes/forged-compass/theme.css"),
  "classic-simple": () => import("../overlay/themes/classic-simple/theme.css"),
  "modern-compact": () => import("../overlay/themes/modern-compact/theme.css"),
  "modern-minimal": () => import("../overlay/themes/modern-minimal/theme.css"),
};

export type ChallengeThemeLoader = (themeId: ChallengeThemeId) => Promise<void>;

export const loadChallengeTheme: ChallengeThemeLoader = async (themeId) => {
  await THEME_IMPORTS[themeId]();
};
