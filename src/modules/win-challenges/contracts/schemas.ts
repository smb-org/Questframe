import { z } from "zod";

import { undoTargetSchema } from "../../../shared/contracts/api";
import type { ChallengeEvent, GlobalTimerEvent } from "./events";
import {
  CHALLENGE_STYLE_IDS,
  DEFAULT_CHALLENGE_PLACEMENT,
  MAX_CHALLENGES,
  MAX_CHALLENGE_SETS,
  MAX_CHALLENGE_SET_NAME_GRAPHEMES,
  MAX_COUNT,
  MAX_CHALLENGE_STEP,
  MAX_MEASURE_COUNT,
  MAX_CHALLENGE_UNIT_GRAPHEMES,
  MAX_VISIBLE_ROWS,
  isChallengeKind,
  isChallengeStep,
  isChallengeUnit,
  isControlKey,
  isChallengeId,
  isChallengeState,
  isChallengeStyleId,
  isChallengeTitle,
  isChallengeSetName,
  isClientId,
  isCommandId,
  isCurrentCount,
  isCurrentCountForKind,
  isDelta,
  isDeltaForKind,
  isDoneOrder,
  isEventSeq,
  isGlobalTimerTotalMs,
  isGlobalTimerMode,
  isChallengeFontFamily,
  isChallengeFontScale,
  isHeaderStyle,
  isHeaderTitle,
  isKeyVisible,
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
  isPenaltyLabel,
  isPenaltyText,
  isRevision,
  isSortOrder,
  isTargetCount,
  isTargetCountForKind,
  isThemeMode,
  isChallengeSurfaceOpacity,
  isChallengeTextEmphasis,
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
export const challengeSetNameSchema = normalized(
  isChallengeSetName,
  `Set-Name muss normalisiert 1–${String(MAX_CHALLENGE_SET_NAME_GRAPHEMES)} Zeichen lang sein.`,
);
const maxCountLabel = String(MAX_MEASURE_COUNT);
const targetCountSchema = custom(isTargetCount, `Ziel muss null oder eine Zahl von 1–${maxCountLabel} sein.`);
const currentCountSchema = custom(isCurrentCount, `Aktueller Stand muss 0–${maxCountLabel} sein.`);
const timerTotalMsSchema = custom(
  isTimerTotalMs,
  "Timerdauer muss null oder 10.000–21.600.000 ms sein.",
);
const timerRemainMsSchema = custom(
  isTimerRemainMs,
  "Eingefrorene Restzeit muss null oder -21.600.000–21.600.000 ms sein.",
);
const globalTimerTotalMsSchema = custom(
  isGlobalTimerTotalMs,
  "Globale Timerdauer muss null oder 10.000–86.400.000 ms sein.",
);
const requiredGlobalTimerTotalMsSchema = custom(
  (value): value is number => isGlobalTimerTotalMs(value) && value !== null,
  "Globale Gesamtdauer muss 10.000–86.400.000 ms sein.",
);
const deltaSchema = custom(
  isDelta,
  `Delta muss zwischen -${String(MAX_MEASURE_COUNT)} und ${String(MAX_MEASURE_COUNT)} liegen.`,
);
const instantSchema = custom(isInstant, "Zeitpunkt muss ein ISO-Instant sein.");
const sortOrderSchema = custom(isSortOrder, "Sortierung muss 0–29 sein.");
const maxVisibleSchema = custom(
  isMaxVisible,
  `Maximal sichtbar müssen 3–${String(MAX_VISIBLE_ROWS)} Einträge sein.`,
);
const placementXSchema = custom(isPlacementX, "X-Position muss eine Ganzzahl von 0–384 sein.");
const placementYSchema = custom(isPlacementY, "Y-Position muss eine Ganzzahl von 0–216 sein.");
const placementScaleSchema = custom(isPlacementScale, "Skalierung muss 0,75–2,00 in 0,01-Schritten sein.");
const challengeKindSchema = custom(isChallengeKind, "Challenge-Typ ist ungültig.");
const challengeUnitSchema = z.union([
  normalized(
    isChallengeUnit,
    `Einheit muss normalisiert 1–${String(MAX_CHALLENGE_UNIT_GRAPHEMES)} Grapheme lang sein.`,
  ),
  z.null(),
]);
const controlKeySchema = custom(isControlKey, "Steuer-Key muss aus vier gültigen Zeichen bestehen.");
const challengeStepSchema = custom(isChallengeStep, `Schrittweite muss 1–${String(MAX_CHALLENGE_STEP)} sein.`);

export const challengePlacementSchema = z.strictObject({
  x: placementXSchema,
  y: placementYSchema,
  scale: placementScaleSchema,
});
const headerTitleSchema = normalized(
  isHeaderTitle,
  "Kopfzeile muss 1–24 Zeichen lang sein.",
);
const penaltyTextSchema = normalized(
  isPenaltyText,
  "Strafe darf höchstens 80 Zeichen lang sein.",
);
const penaltyLabelSchema = normalized(
  isPenaltyLabel,
  "Strafen-Titel darf höchstens 24 Zeichen lang sein.",
);
const revisionSchema = custom(isRevision, "Revision muss positiv sein.");
const eventSeqSchema = custom(isEventSeq, "Event-Sequenz muss nichtnegativ sein.");
const pausedRemainMsSchema = custom(
  isPausedRemainMs,
  "Pausierte Restzeit muss null oder -86.400.000–86.400.000 ms sein.",
);
const challengeStateSchema = custom(
  isChallengeState,
  "Unbekannter Challenge-Zustand.",
);
const styleIdSchema = custom(
  isChallengeStyleId,
  `Style muss einer dieser Werte sein: ${CHALLENGE_STYLE_IDS.join(", ")}.`,
);
const themeModeSchema = custom(isThemeMode, "Theme-Modus ist ungültig.");
const surfaceOpacitySchema = custom(isChallengeSurfaceOpacity, "Flächenopazität ist ungültig.");
const headerStyleSchema = custom(isHeaderStyle, "Kopfzeilen-Stil ist ungültig.");
const textEmphasisSchema = custom(isChallengeTextEmphasis, "Schrifteffekt ist ungültig.");
const fontFamilySchema = custom(isChallengeFontFamily, "Schriftart ist ungültig.");
const fontScaleSchema = custom(isChallengeFontScale, "Schriftgröße muss 0,75–2,00 in 0,05-Schritten sein.");
const overflowModeSchema = custom(isOverflowMode, "Überlaufmodus ist ungültig.");
const overflowTempoSchema = custom(isOverflowTempo, "Überlauf-Tempo ist ungültig.");
const doneOrderSchema = custom(isDoneOrder, "Erledigt-Reihenfolge ist ungültig.");
const globalTimerModeSchema = custom(isGlobalTimerMode, "Globaler Timer-Modus ist ungültig.");
const numberedSchema = custom(isNumbered, "Nummerierung muss ein Boolean sein.");
const keyVisibleSchema = custom(isKeyVisible, "Steuer-Keys müssen ein Boolean sein.");
const commandIdSchema = custom(isCommandId, "Kommando-ID muss eine UUID sein.");

const validateChallengeKindSemantics = (
  value: {
    kind: "tick" | "counter" | "streak" | "measure";
    targetCount: number | null;
    unit: string | null;
    bestCount?: number;
    currentCount?: number;
  },
  context: z.RefinementCtx,
  pathPrefix: readonly PropertyKey[] = [],
): void => {
  if (!isTargetCountForKind(value.targetCount, value.kind)) {
    context.addIssue({
      code: "custom",
      path: [...pathPrefix, "targetCount"],
      message: `Ziel darf für ${value.kind} höchstens ${String(value.kind === "measure" ? MAX_MEASURE_COUNT : MAX_COUNT)} sein.`,
    });
  }
  if (value.bestCount !== undefined && !isCurrentCountForKind(value.bestCount, value.kind)) {
    context.addIssue({
      code: "custom",
      path: [...pathPrefix, "bestCount"],
      message: `Rekord darf für ${value.kind} höchstens ${String(value.kind === "measure" ? MAX_MEASURE_COUNT : MAX_COUNT)} sein.`,
    });
  }
  if (value.currentCount !== undefined && !isCurrentCountForKind(value.currentCount, value.kind)) {
    context.addIssue({
      code: "custom",
      path: [...pathPrefix, "currentCount"],
      message: `Aktueller Stand darf für ${value.kind} höchstens ${String(value.kind === "measure" ? MAX_MEASURE_COUNT : MAX_COUNT)} sein.`,
    });
  }
  if (value.kind === "tick" && value.targetCount !== null) {
    context.addIssue({
      code: "custom",
      path: [...pathPrefix, "targetCount"],
      message: "Ein Tick braucht kein Ziel.",
    });
  }
  if ((value.kind === "streak" || value.kind === "measure") && value.targetCount === null) {
    context.addIssue({
      code: "custom",
      path: [...pathPrefix, "targetCount"],
      message: `${value.kind === "streak" ? "Eine Streak" : "Ein Messwert"} braucht ein Ziel.`,
    });
  }
  if (value.kind === "measure" && value.unit === null) {
    context.addIssue({
      code: "custom",
      path: [...pathPrefix, "unit"],
      message: "Ein Messwert braucht eine Einheit.",
    });
  }
  if (value.kind !== "measure" && value.unit !== null) {
    context.addIssue({
      code: "custom",
      path: [...pathPrefix, "unit"],
      message: "Eine Einheit ist nur für Messwerte erlaubt.",
    });
  }
};

const challengeDefinitionFields = {
  title: challengeTitleSchema,
  kind: challengeKindSchema.default("counter"),
  unit: challengeUnitSchema.default(null),
  targetCount: targetCountSchema,
  timerTotalMs: timerTotalMsSchema,
  sortOrder: sortOrderSchema,
  step: challengeStepSchema.default(1),
  hidden: z.boolean().default(false),
} as const;

/** Der Wächter erzwingt eine bewusste Entscheidung, wenn der interne Satz wächst. */
export const challengeDefinitionFieldKeys = Object.keys(challengeDefinitionFields) as Array<keyof typeof challengeDefinitionFields>;
export const challengeSetV1FieldPolicy = {
  title: "include",
  kind: "include",
  unit: "include",
  targetCount: "include",
  timerTotalMs: "include",
  sortOrder: "include",
  step: "include",
  hidden: "include",
} as const satisfies Record<keyof typeof challengeDefinitionFields, "include" | "ignore" | "v2">;

export const challengeDefinitionSchema = z
  .union([
    z.strictObject({ id: challengeIdSchema, ...challengeDefinitionFields }),
    z.strictObject({ clientId: clientIdSchema, ...challengeDefinitionFields }),
  ])
  .superRefine((value, context) => {
    validateChallengeKindSemantics(value, context);
  });

const challengeSetProgressSchema = z.strictObject({
  currentCount: currentCountSchema,
  bestCount: currentCountSchema,
  state: challengeStateSchema,
  timerRemainMs: z.union([timerRemainMsSchema, z.null()]),
  completedAt: z.union([instantSchema, z.null()]),
});

const challengeSetChallengeSchema = z
  .strictObject({
    // V1 zählt diese Felder absichtlich einzeln auf. Keine Ableitung aus
    // challengeDefinitionFields: Die eingefrorene Datei darf nicht mit dem
    // internen Vertrag mitwandern.
    title: challengeTitleSchema,
    kind: challengeKindSchema,
    unit: challengeUnitSchema,
    targetCount: targetCountSchema,
    timerTotalMs: timerTotalMsSchema,
    sortOrder: sortOrderSchema,
    step: challengeStepSchema,
    hidden: z.boolean(),
    progress: challengeSetProgressSchema.optional(),
  })
  .superRefine((value, context) => {
    validateChallengeKindSemantics(value, context);
    if (value.progress !== undefined) {
      validateChallengeKindSemantics(
        { ...value, ...value.progress },
        context,
        ["progress"],
      );
    }
  });

export const challengeSetV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  createdAt: instantSchema,
  challenges: z.array(challengeSetChallengeSchema).max(MAX_CHALLENGES),
});

const challengeSetTypeSchema = z.union([z.literal("user"), z.literal("autosave")]);
const challengeSetIdSchema = z.string().min(1).max(80);

export const challengeSetSummarySchema = z.strictObject({
  id: challengeSetIdSchema,
  type: challengeSetTypeSchema,
  name: z.string().min(1).max(80),
  hasProgress: z.boolean(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export const challengeSetListResponseSchema = z.strictObject({
  sets: z.array(challengeSetSummarySchema).max(MAX_CHALLENGE_SETS + 1),
});

export const challengeSetResponseSchema = z.strictObject({
  summary: challengeSetSummarySchema,
  set: challengeSetV1Schema,
});

export const challengeSetSaveRequestSchema = z.strictObject({
  name: challengeSetNameSchema,
  includeProgress: z.boolean(),
  setId: challengeSetIdSchema.optional(),
});

export const challengeSetDeleteResponseSchema = z.strictObject({
  id: challengeSetIdSchema,
  deleted: z.literal(true),
});

export const challengeSchema = z
  .strictObject({
    id: challengeIdSchema,
    title: challengeTitleSchema,
    kind: challengeKindSchema,
    unit: challengeUnitSchema,
    controlKey: controlKeySchema,
    targetCount: targetCountSchema,
    timerTotalMs: timerTotalMsSchema,
    sortOrder: sortOrderSchema,
    step: challengeStepSchema,
    bestCount: currentCountSchema,
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
    validateChallengeKindSemantics(value, context);
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
  textEmphasis: textEmphasisSchema,
  fontFamily: fontFamilySchema,
  fontScale: fontScaleSchema,
  headerTitle: headerTitleSchema,
  penaltyLabel: penaltyLabelSchema,
  penaltyText: penaltyTextSchema,
  effectsEnabled: z.boolean(),
  maxVisible: maxVisibleSchema,
  overflowMode: overflowModeSchema,
  overflowTempo: overflowTempoSchema,
  numbered: numberedSchema,
  keyVisible: keyVisibleSchema,
  doneOrder: doneOrderSchema,
  globalTimerMode: globalTimerModeSchema,
  globalTimer: z.union([globalTimerSchema, z.null()]),
  placement: challengePlacementSchema.default(DEFAULT_CHALLENGE_PLACEMENT),
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
    type: z.literal("resetStreak"),
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
  reason: z.literal("set-switch").optional(),
  setId: challengeSetIdSchema.optional(),
});

export const challengeBoardSnapshotSchema = z.strictObject({
  eventSeq: eventSeqSchema,
  boardRevision: revisionSchema,
  settingsRevision: revisionSchema,
  settings: settingsSchema,
  challenges: z.array(challengeSchema).max(MAX_CHALLENGES),
});

export const boardSaveResponseSchema = z.strictObject({
  snapshot: challengeBoardSnapshotSchema,
  createdIds: z.record(z.string().min(1), challengeIdSchema),
});

export const settingsSaveResponseSchema = z.strictObject({
  snapshot: challengeBoardSnapshotSchema,
});

export const challengeUndoResponseSchema = z.strictObject({
  snapshot: challengeBoardSnapshotSchema,
  undoTargets: z.array(undoTargetSchema).max(20),
  serverTime: z.iso.datetime({ offset: true }),
});

export const commandResponseSchema = z.strictObject({
  eventSeq: eventSeqSchema,
  replayed: z.boolean(),
  challenge: challengeSchema.optional(),
  settings: settingsSchema.optional(),
});

export const settingsSaveRequestSchema = z.strictObject({
  baseSettingsRevision: revisionSchema,
  styleId: styleIdSchema,
  themeMode: themeModeSchema,
  surfaceOpacity: surfaceOpacitySchema,
  headerStyle: headerStyleSchema,
  textEmphasis: textEmphasisSchema,
  fontFamily: fontFamilySchema,
  fontScale: fontScaleSchema,
  headerTitle: headerTitleSchema,
  penaltyLabel: penaltyLabelSchema,
  penaltyText: penaltyTextSchema,
  effectsEnabled: z.boolean(),
  maxVisible: maxVisibleSchema,
  overflowMode: overflowModeSchema,
  overflowTempo: overflowTempoSchema,
  numbered: numberedSchema,
  keyVisible: keyVisibleSchema,
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
      z.literal("streak-reset"),
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

const boardEventSchema = z.strictObject({
  scope: z.literal("board"),
  type: z.literal("set_switched"),
});

export const challengeUpdateSchema = z.strictObject({
  eventSeq: eventSeqSchema,
  boardRevision: revisionSchema,
  settingsRevision: revisionSchema,
  settings: settingsSchema,
  challenges: z.array(challengeSchema).max(MAX_CHALLENGES),
  event: z.union([challengeEventSchema, globalTimerEventSchema, boardEventSchema, z.null()]),
}).superRefine((value, context) => {
  const event = value.event;
  if (event?.scope !== "challenge" || event.type !== "progressed") return;
  const challenge = value.challenges.find(({ id }) => id === event.challengeId);
  if (challenge === undefined) {
    context.addIssue({
      code: "custom",
      path: ["event", "challengeId"],
      message: "Progress-Event verweist auf keine Challenge im Snapshot.",
    });
    return;
  }
  if (!isDeltaForKind(event.delta, challenge.kind)) {
    context.addIssue({
      code: "custom",
      path: ["event", "delta"],
      message: `Delta darf für ${challenge.kind} höchstens ${String(challenge.kind === "measure" ? MAX_MEASURE_COUNT : MAX_COUNT)} betragen.`,
    });
  }
  if (!isCurrentCountForKind(event.previousCount, challenge.kind)) {
    context.addIssue({
      code: "custom",
      path: ["event", "previousCount"],
      message: "Vorheriger Stand überschreitet die Typgrenze.",
    });
  }
  if (!isCurrentCountForKind(event.currentCount, challenge.kind)) {
    context.addIssue({
      code: "custom",
      path: ["event", "currentCount"],
      message: "Aktueller Stand überschreitet die Typgrenze.",
    });
  }
});

export type Challenge = z.infer<typeof challengeSchema>;
export type ChallengeDefinition = z.infer<typeof challengeDefinitionSchema>;
export type ChallengeSetV1 = z.infer<typeof challengeSetV1Schema>;
export type ChallengeSetV1Challenge = ChallengeSetV1["challenges"][number];
export type ChallengeSetSummary = z.infer<typeof challengeSetSummarySchema>;
export type ChallengeSetSaveRequest = z.infer<typeof challengeSetSaveRequestSchema>;
export type ChallengeSetResponse = z.infer<typeof challengeSetResponseSchema>;
export type ChallengeSetListResponse = z.infer<typeof challengeSetListResponseSchema>;
export type GlobalTimer = z.infer<typeof globalTimerSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type Command = z.infer<typeof commandSchema>;
export type BoardSaveRequest = z.infer<typeof boardSaveRequestSchema>;
export type ChallengeBoardSnapshot = z.infer<typeof challengeBoardSnapshotSchema>;
export type BoardSaveResponse = z.infer<typeof boardSaveResponseSchema>;
export type SettingsSaveResponse = z.infer<typeof settingsSaveResponseSchema>;
export type ChallengeUndoResponse = z.infer<typeof challengeUndoResponseSchema>;
export type SettingsSaveRequest = z.infer<typeof settingsSaveRequestSchema>;
export type CommandResponse = z.infer<typeof commandResponseSchema>;
export type ChallengeUpdate = z.infer<typeof challengeUpdateSchema>;

export type ChallengeEventPayload = ChallengeEvent;
export type GlobalTimerEventPayload = GlobalTimerEvent;
