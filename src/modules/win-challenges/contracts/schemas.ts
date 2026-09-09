import { z } from "zod";

import type { ChallengeEvent, GlobalTimerEvent } from "./events";
import {
  CHALLENGE_STYLE_IDS,
  CHALLENGE_THEME_IDS,
  DEFAULT_CHALLENGE_PLACEMENT,
  MAX_CHALLENGES,
  MAX_COUNT,
  MAX_VISIBLE_ROWS,
  isChallengeId,
  isChallengeState,
  isChallengeStyleId,
  isChallengeTitle,
  isClientId,
  isCommandId,
  isCurrentCount,
  isDelta,
  isDoneOrder,
  isEventSeq,
  isGlobalTimerTotalMs,
  isGlobalTimerMode,
  isChallengeFontFamily,
  isChallengeFontScale,
  isHeaderStyle,
  isHeaderTitle,
  isHidden,
  isInstant,
  isMaxVisible,
  isNumbered,
  isOverflowMode,
  isOverflowTempo,
  isPausedRemainMs,
  isPlacementScale,
  isPlacementX,
  isPlacementY,
  isRevision,
  isSortOrder,
  isTargetCount,
  isThemeId,
  isThemeMode,
  isChallengeSurfaceOpacity,
  isTimerTotalMs,
  isTimerRemainMs,
  normalizeChallengeText,
} from "./predicates";

const custom = <T>(
  predicate: (value: unknown) => value is T,
  message: string,
): z.ZodType<T> => z.custom<T>(predicate, { message });

const normalized = <T>(
  predicate: (value: unknown) => value is T,
  message: string,
): z.ZodType<T> =>
  z.preprocess(
    (value) => (typeof value === "string" ? normalizeChallengeText(value) : value),
    custom(predicate, message),
  );

const challengeIdSchema = custom(isChallengeId, "Challenge-ID ist erforderlich.");
const clientIdSchema = custom(isClientId, "Client-ID ist erforderlich.");
const challengeTitleSchema = normalized(isChallengeTitle, "Challenge muss 1–160 Zeichen lang sein.");
const maxCountLabel = String(MAX_COUNT);
const targetCountSchema = custom(isTargetCount, `Ziel muss null oder eine Zahl von 1–${maxCountLabel} sein.`);
const currentCountSchema = custom(isCurrentCount, `Aktueller Stand muss 0–${maxCountLabel} sein.`);
const timerTotalMsSchema = custom(
  isTimerTotalMs,
  "Timerdauer muss null oder 10.000–21.600.000 ms sein.",
);
const timerRemainMsSchema = custom(
  isTimerRemainMs,
  "Eingefrorene Restzeit muss null oder 0–21.600.000 ms sein.",
);
const globalTimerTotalMsSchema = custom(
  isGlobalTimerTotalMs,
  "Globale Timerdauer muss null oder 10.000–86.400.000 ms sein.",
);
const requiredGlobalTimerTotalMsSchema = custom(
  (value): value is number => isGlobalTimerTotalMs(value) && value !== null,
  "Globale Gesamtdauer muss 10.000–86.400.000 ms sein.",
);
const deltaSchema = custom(isDelta, "Delta muss zwischen -99 und 99 liegen.");
const instantSchema = custom(isInstant, "Zeitpunkt muss ein ISO-Instant sein.");
const sortOrderSchema = custom(isSortOrder, "Sortierung muss 0–29 sein.");
const maxVisibleSchema = custom(
  isMaxVisible,
  `Maximal sichtbar müssen 3–${String(MAX_VISIBLE_ROWS)} Einträge sein.`,
);
const placementXSchema = custom(isPlacementX, "X-Position muss eine Ganzzahl von 0–384 sein.");
const placementYSchema = custom(isPlacementY, "Y-Position muss eine Ganzzahl von 0–216 sein.");
const placementScaleSchema = custom(isPlacementScale, "Skalierung muss 0,75–2,00 in 0,01-Schritten sein.");

export const challengePlacementSchema = z.strictObject({
  x: placementXSchema,
  y: placementYSchema,
  scale: placementScaleSchema,
});
const headerTitleSchema = normalized(
  isHeaderTitle,
  "Kopfzeile muss 1–24 Zeichen lang sein.",
);
const revisionSchema = custom(isRevision, "Revision muss positiv sein.");
const eventSeqSchema = custom(isEventSeq, "Event-Sequenz muss nichtnegativ sein.");
const pausedRemainMsSchema = custom(
  isPausedRemainMs,
  "Pausierte Restzeit muss null oder 0–86.400.000 ms sein.",
);
const challengeStateSchema = custom(
  isChallengeState,
  "Unbekannter Challenge-Zustand.",
);
const styleIdSchema = custom(
  isChallengeStyleId,
  `Style muss einer dieser Werte sein: ${CHALLENGE_STYLE_IDS.join(", ")}.`,
);
const themeIdSchema = custom(
  isThemeId,
  `Theme muss einer dieser Werte sein: ${CHALLENGE_THEME_IDS.join(", ")}.`,
);
const themeModeSchema = custom(isThemeMode, "Theme-Modus ist ungültig.");
const surfaceOpacitySchema = custom(isChallengeSurfaceOpacity, "Flächenopazität ist ungültig.");
const headerStyleSchema = custom(isHeaderStyle, "Kopfzeilen-Stil ist ungültig.");
const fontFamilySchema = custom(isChallengeFontFamily, "Schriftart ist ungültig.");
const fontScaleSchema = custom(isChallengeFontScale, "Schriftgröße muss 0,75–2,00 in 0,05-Schritten sein.");
const overflowModeSchema = custom(isOverflowMode, "Überlaufmodus ist ungültig.");
const overflowTempoSchema = custom(isOverflowTempo, "Überlauf-Tempo ist ungültig.");
const doneOrderSchema = custom(isDoneOrder, "Erledigt-Reihenfolge ist ungültig.");
const globalTimerModeSchema = custom(isGlobalTimerMode, "Globaler Timer-Modus ist ungültig.");
const numberedSchema = custom(isNumbered, "Nummerierung muss ein Boolean sein.");
const commandIdSchema = custom(isCommandId, "Kommando-ID muss eine UUID sein.");

const challengeDefinitionFields = {
  title: challengeTitleSchema,
  targetCount: targetCountSchema,
  timerTotalMs: timerTotalMsSchema,
  sortOrder: sortOrderSchema,
  hidden: z.boolean().default(false),
} as const;

export const challengeDefinitionSchema = z.union([
  z.strictObject({ id: challengeIdSchema, ...challengeDefinitionFields }),
  z.strictObject({ clientId: clientIdSchema, ...challengeDefinitionFields }),
]);

export const challengeSchema = z
  .strictObject({
    id: challengeIdSchema,
    title: challengeTitleSchema,
    targetCount: targetCountSchema,
    timerTotalMs: timerTotalMsSchema,
    sortOrder: sortOrderSchema,
    hidden: custom(isHidden, "Ausgeblendet muss ein Boolean sein."),
    currentCount: currentCountSchema,
    state: challengeStateSchema,
    timerEndsAt: z.union([instantSchema, z.null()]),
    timerRemainMs: z.union([timerRemainMsSchema, z.null()]),
    completedAt: z.union([instantSchema, z.null()]),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .superRefine((value, context) => {
    if (value.timerEndsAt !== null && value.timerRemainMs !== null) {
      context.addIssue({
        code: "custom",
        path: ["timerRemainMs"],
        message: "Eine Challenge darf nicht gleichzeitig laufen und pausiert sein.",
      });
    }
  });

export const globalTimerSchema = z
  .strictObject({
    totalMs: requiredGlobalTimerTotalMsSchema,
    endsAt: z.union([instantSchema, z.null()]),
    pausedRemainMs: z.union([pausedRemainMsSchema, z.null()]),
  })
  .superRefine((value, context) => {
    if (value.endsAt !== null && value.pausedRemainMs !== null) {
      context.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "Ein globaler Timer darf nicht gleichzeitig laufen und pausiert sein.",
      });
    }
    if (value.pausedRemainMs !== null && value.pausedRemainMs > value.totalMs) {
      context.addIssue({
        code: "custom",
        path: ["pausedRemainMs"],
        message: "Pausierte Restzeit darf die Gesamtdauer nicht überschreiten.",
      });
    }
  });

export const settingsSchema = z.strictObject({
  styleId: styleIdSchema,
  themeMode: themeModeSchema,
  surfaceOpacity: surfaceOpacitySchema,
  headerStyle: headerStyleSchema,
  fontFamily: fontFamilySchema,
  fontScale: fontScaleSchema,
  headerTitle: headerTitleSchema,
  effectsEnabled: z.boolean(),
  maxVisible: maxVisibleSchema,
  overflowMode: overflowModeSchema,
  overflowTempo: overflowTempoSchema,
  numbered: numberedSchema,
  doneOrder: doneOrderSchema,
  globalTimerMode: globalTimerModeSchema,
  themeId: themeIdSchema,
  globalTimer: z.union([globalTimerSchema, z.null()]),
  placement: challengePlacementSchema.default(DEFAULT_CHALLENGE_PLACEMENT),
});

const challengeRepositorySettingsSchema = settingsSchema.omit({ themeId: true });

const challengeCommandBase = {
  commandId: commandIdSchema,
  scope: z.literal("challenge"),
  challengeId: challengeIdSchema,
} as const;

export const commandSchema = z.union([
  z.strictObject({
    ...challengeCommandBase,
    type: z.literal("increment"),
    delta: deltaSchema,
  }),
  z.strictObject({
    ...challengeCommandBase,
    type: z.union([
      z.literal("complete"),
      z.literal("reopen"),
      z.literal("startTimer"),
      z.literal("stopTimer"),
      z.literal("resetTimer"),
    ]),
  }),
  z.strictObject({
    commandId: commandIdSchema,
    scope: z.literal("global"),
    type: z.union([
      z.literal("startGlobalTimer"),
      z.literal("pauseGlobalTimer"),
      z.literal("resetGlobalTimer"),
    ]),
  }),
]);

export const boardSaveRequestSchema = z.strictObject({
  baseBoardRevision: revisionSchema,
  challenges: z.array(challengeDefinitionSchema).max(MAX_CHALLENGES),
});

export const challengeBoardSnapshotSchema = z.strictObject({
  eventSeq: eventSeqSchema,
  boardRevision: revisionSchema,
  settingsRevision: revisionSchema,
  settings: challengeRepositorySettingsSchema,
  challenges: z.array(challengeSchema).max(MAX_CHALLENGES),
});

export const boardSaveResponseSchema = z.strictObject({
  snapshot: challengeBoardSnapshotSchema,
  createdIds: z.record(z.string().min(1), challengeIdSchema),
});

export const settingsSaveResponseSchema = z.strictObject({
  snapshot: challengeBoardSnapshotSchema,
});

export const commandResponseSchema = z.strictObject({
  eventSeq: eventSeqSchema,
  replayed: z.boolean(),
  challenge: challengeSchema.optional(),
  settings: challengeRepositorySettingsSchema.optional(),
});

export const settingsSaveRequestSchema = z.strictObject({
  baseSettingsRevision: revisionSchema,
  styleId: styleIdSchema,
  themeMode: themeModeSchema,
  surfaceOpacity: surfaceOpacitySchema,
  headerStyle: headerStyleSchema,
  fontFamily: fontFamilySchema,
  fontScale: fontScaleSchema,
  headerTitle: headerTitleSchema,
  effectsEnabled: z.boolean(),
  maxVisible: maxVisibleSchema,
  overflowMode: overflowModeSchema,
  overflowTempo: overflowTempoSchema,
  numbered: numberedSchema,
  doneOrder: doneOrderSchema,
  globalTimerMode: globalTimerModeSchema,
  globalTimerTotalMs: globalTimerTotalMsSchema,
  placement: challengePlacementSchema,
});

const challengeEventSchema = z.union([
  z.strictObject({
    scope: z.literal("challenge"),
    type: z.literal("progressed"),
    challengeId: challengeIdSchema,
    delta: deltaSchema,
    previousCount: currentCountSchema,
    currentCount: currentCountSchema,
  }),
  z.strictObject({
    scope: z.literal("challenge"),
    type: z.union([
      z.literal("completed"),
      z.literal("reopened"),
      z.literal("timer_started"),
      z.literal("timer_stopped"),
    ]),
    challengeId: challengeIdSchema,
  }),
]);

const globalTimerEventSchema = z.strictObject({
  scope: z.literal("global"),
  type: z.union([
    z.literal("global_started"),
    z.literal("global_paused"),
    z.literal("global_reset"),
  ]),
});

export const challengeUpdateSchema = z.strictObject({
  eventSeq: eventSeqSchema,
  boardRevision: revisionSchema,
  settingsRevision: revisionSchema,
  settings: settingsSchema,
  challenges: z.array(challengeSchema).max(MAX_CHALLENGES),
  event: z.union([challengeEventSchema, globalTimerEventSchema, z.null()]),
});

export type Challenge = z.infer<typeof challengeSchema>;
export type ChallengeDefinition = z.infer<typeof challengeDefinitionSchema>;
export type GlobalTimer = z.infer<typeof globalTimerSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type Command = z.infer<typeof commandSchema>;
export type BoardSaveRequest = z.infer<typeof boardSaveRequestSchema>;
export type ChallengeBoardSnapshot = z.infer<typeof challengeBoardSnapshotSchema>;
export type BoardSaveResponse = z.infer<typeof boardSaveResponseSchema>;
export type SettingsSaveResponse = z.infer<typeof settingsSaveResponseSchema>;
export type SettingsSaveRequest = z.infer<typeof settingsSaveRequestSchema>;
export type CommandResponse = z.infer<typeof commandResponseSchema>;
export type ChallengeUpdate = z.infer<typeof challengeUpdateSchema>;

export type ChallengeEventPayload = ChallengeEvent;
export type GlobalTimerEventPayload = GlobalTimerEvent;
