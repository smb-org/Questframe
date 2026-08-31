import type { ThemeId } from "../../shared/contracts/state";

export const THEME_LABELS: Record<ThemeId, string> = {
  "trail-wood": "Trail Wood",
  "field-journal": "Field Journal",
  "forged-compass": "Forged Compass",
  "classic-simple": "Classic Simple",
  "modern-compact": "Modern Compact",
  "modern-minimal": "Modern Minimal",
};

export const HUD_SCALE_OPTIONS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
