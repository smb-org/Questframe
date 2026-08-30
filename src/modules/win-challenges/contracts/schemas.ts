import { z } from "zod";

import type { ChallengeEvent, GlobalTimerEvent } from "./events";
import {
  CHALLENGE_STYLE_IDS,
  CHALLENGE_THEME_IDS,
  MAX_CHALLENGES,
  isChallengeDescription,
  isChallengeId,
  isChallengeState,
  isChallengeStyleId,
  isChallengeTitle,
  isClientId,
  isCommandId,
  isCurrentCount,
  isDelta,
  isEventSeq,
  isHeaderTitle,
  isInstant,
  isMaxVisible,
  isPausedRemainMs,
  isRevision,
  isSortOrder,
  isTargetCount,
  isThemeId,
  isThemeMode,
  isSurfaceMode,
  isTimerTotalMs,
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
const challengeTitleSchema = normalized(isChallengeTitle, "Titel muss 1–80 Zeichen lang sein.");
const challengeDescriptionSchema = normalized(
  isChallengeDescription,
  "Beschreibung muss 0–160 Zeichen lang sein oder null sein.",
);
const targetCountSchema = custom(isTargetCount, "Ziel muss null oder eine Zahl von 1–999 sein.");
const currentCountSchema = custom(isCurrentCount, "Aktueller Stand muss 0–999 sein.");
const timerTotalMsSchema = custom(
  isTimerTotalMs,
  "Timerdauer muss null oder 10.000–21.600.000 ms sein.",
);
const requiredTimerTotalMsSchema = custom(
  (value): value is number => isTimerTotalMs(value) && value !== null,
  "Gesamtdauer muss 10.000–21.600.000 ms sein.",
);
const deltaSchema = custom(isDelta, "Delta muss zwischen -99 und 99 liegen.");
const instantSchema = custom(isInstant, "Zeitpunkt muss ein ISO-Instant sein.");
const sortOrderSchema = custom(isSortOrder, "Sortierung muss 0–29 sein.");
const maxVisibleSchema = custom(isMaxVisible, "Maximal sichtbar müssen 3–10 Einträge sein.");
const headerTitleSchema = normalized(
  isHeaderTitle,
  "Kopfzeile muss 1–24 Zeichen lang sein.",
);
const revisionSchema = custom(isRevision, "Revision muss positiv sein.");
const eventSeqSchema = custom(isEventSeq, "Event-Sequenz muss nichtnegativ sein.");
const pausedRemainMsSchema = custom(
  isPausedRemainMs,
  "Pausierte Restzeit muss null oder 0–21.600.000 ms sein.",
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
const surfaceModeSchema = custom(isSurfaceMode, "Flächenmodus ist ungültig.");
const commandIdSchema = custom(isCommandId, "Kommando-ID muss eine UUID sein.");

const challengeDefinitionFields = {
  title: challengeTitleSchema,
  description: challengeDescriptionSchema,
  targetCount: targetCountSchema,
  timerTotalMs: timerTotalMsSchema,
  sortOrder: sortOrderSchema,
} as const;

export const challengeDefinitionSchema = z.union([
  z.strictObject({ id: challengeIdSchema, ...challengeDefinitionFields }),
  z.strictObject({ clientId: clientIdSchema, ...challengeDefinitionFields }),
]);

export const challengeSchema = z.strictObject({
  id: challengeIdSchema,
  title: challengeTitleSchema,
  description: challengeDescriptionSchema,
  targetCount: targetCountSchema,
  timerTotalMs: timerTotalMsSchema,
  sortOrder: sortOrderSchema,
  currentCount: currentCountSchema,
  state: challengeStateSchema,
  timerEndsAt: z.union([instantSchema, z.null()]),
  completedAt: z.union([instantSchema, z.null()]),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export const globalTimerSchema = z
  .strictObject({
    totalMs: requiredTimerTotalMsSchema,
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
  surfaceMode: surfaceModeSchema,
  headerTitle: headerTitleSchema,
  effectsEnabled: z.boolean(),
  maxVisible: maxVisibleSchema,
  themeId: themeIdSchema,
  globalTimer: z.union([globalTimerSchema, z.null()]),
});

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
export type ChallengeUpdate = z.infer<typeof challengeUpdateSchema>;

export type ChallengeEventPayload = ChallengeEvent;
export type GlobalTimerEventPayload = GlobalTimerEvent;
