import { z } from "zod";

const graphemeSegmenter = new Intl.Segmenter("de", { granularity: "grapheme" });

const graphemeLength = (value: string): number =>
  [...graphemeSegmenter.segment(value)].length;

const normalizedText = (minimum: number, maximum: number) =>
  z
    .string()
    .transform((value) => value.normalize("NFC").trim())
    .pipe(
      z.string().superRefine((value, context) => {
        const length = graphemeLength(value);
        if (length < minimum || length > maximum) {
          context.addIssue({
            code: "custom",
            message: `Muss ${String(minimum)}–${String(maximum)} Zeichen lang sein.`,
          });
        }
        if (value.length > maximum) {
          context.addIssue({
            code: "custom",
            message: `Darf höchstens ${String(maximum)} UTF-16-Codeeinheiten lang sein.`,
          });
        }
      }),
    );

const nullableText = (maximum: number) =>
  z.union([z.null(), normalizedText(1, maximum)]);

export const twitchUserIdSchema = z
  .string()
  .regex(/^\d+$/, "Twitch-ID muss eine Dezimalzeichenfolge sein.")
  .brand<"TwitchUserId">();

export const percentSchema = z.number().int().min(0).max(100);

export const portraitRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("bundled"),
    assetId: normalizedText(1, 64),
  }),
  z.strictObject({
    kind: z.literal("uploaded"),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    kind: z.literal("twitch"),
    userId: twitchUserIdSchema,
    url: z.url().max(2_048),
  }),
  z.strictObject({
    kind: z.literal("initials"),
    text: normalizedText(1, 4),
  }),
]);

export const groupMemberSchema = z.strictObject({
  id: normalizedText(1, 64),
  source: z.enum(["twitch", "manual"]),
  twitchUserId: z.union([twitchUserIdSchema, z.null()]),
  name: normalizedText(1, 32),
  portrait: portraitRefSchema,
  hpPercent: percentSchema,
});

export const activeEffectSchema = z.strictObject({
  id: normalizedText(1, 64),
  catalogId: z.union([normalizedText(1, 64), z.null()]),
  kind: z.enum(["buff", "debuff"]),
  name: normalizedText(1, 24),
  description: nullableText(90),
  iconId: normalizedText(1, 64),
  stacks: z.union([z.number().int().min(1).max(99), z.null()]),
  expiresAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
  order: z.number().int().min(0).max(7),
});

const THEME_IDS = [
  "trail-wood",
  "field-journal",
  "forged-compass",
  "classic-simple",
  "modern-compact",
  "modern-minimal",
] as const;

// Vor der Dreifach-Bildvariante hieß die Standarddarstellung "classic-remix".
const LEGACY_THEME_IDS: Record<string, (typeof THEME_IDS)[number]> = {
  "classic-remix": "trail-wood",
};

const themeIdSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value in LEGACY_THEME_IDS ? LEGACY_THEME_IDS[value] : value,
  z.enum(THEME_IDS),
);

const stateContentShape = {
  schemaVersion: z.literal(1),
  themeId: themeIdSchema,
  placement: z.strictObject({
    x: z.number().int().min(0).max(384),
    y: z.number().int().min(0).max(216),
    scale: z.number().min(0.75).max(2).multipleOf(0.01),
  }),
  player: z.strictObject({
    name: normalizedText(1, 32),
    title: nullableText(40),
    level: z.number().int().min(1).max(999),
    portrait: portraitRefSchema,
    hpPercent: percentSchema,
    resource: z.strictObject({
      name: normalizedText(1, 16),
      color: z.string().regex(/^#[A-Fa-f0-9]{6}$/),
      percent: percentSchema,
    }),
  }),
  pet: z.union([
    z.null(),
    z.strictObject({
      name: normalizedText(1, 32),
      subtitle: nullableText(40),
      portrait: portraitRefSchema,
      hpPercent: percentSchema,
    }),
  ]),
  group: z.array(groupMemberSchema).max(5),
  effects: z.array(activeEffectSchema).max(8),
  featuredEffectId: z.union([normalizedText(1, 64), z.null()]),
} as const;

const addStateContentIssues = (
  value: {
    group: z.infer<typeof groupMemberSchema>[];
    effects: z.infer<typeof activeEffectSchema>[];
    featuredEffectId: string | null;
  },
  context: z.RefinementCtx,
): void => {
  const groupIds = new Set<string>();
  value.group.forEach((member, index) => {
    if (groupIds.has(member.id)) {
      context.addIssue({
        code: "custom",
        path: ["group", index, "id"],
        message: "Gruppen-ID muss eindeutig sein.",
      });
    }
    groupIds.add(member.id);
    if (member.source === "twitch" && member.twitchUserId === null) {
      context.addIssue({
        code: "custom",
        path: ["group", index, "twitchUserId"],
        message: "Twitch-Gäste benötigen eine Twitch-ID.",
      });
    }
    if (member.source === "manual" && member.twitchUserId !== null) {
      context.addIssue({
        code: "custom",
        path: ["group", index, "twitchUserId"],
        message: "Manuelle Gäste dürfen keine Twitch-ID enthalten.",
      });
    }
    if (member.source === "manual" && member.portrait.kind === "twitch") {
      context.addIssue({
        code: "custom",
        path: ["group", index, "portrait"],
        message: "Manuelle Gäste dürfen kein Twitch-Portrait verwenden.",
      });
    }
  });

  const effectIds = new Set<string>();
  value.effects.forEach((effect, index) => {
    if (effectIds.has(effect.id)) {
      context.addIssue({
        code: "custom",
        path: ["effects", index, "id"],
        message: "Effekt-ID muss eindeutig sein.",
      });
    }
    effectIds.add(effect.id);
    if (effect.order !== index) {
      context.addIssue({
        code: "custom",
        path: ["effects", index, "order"],
        message: "Effektreihenfolge muss lückenlos sein.",
      });
    }
  });

  if (value.featuredEffectId !== null) {
    const featured = value.effects.find(
      (effect) => effect.id === value.featuredEffectId,
    );
    if (featured?.description == null) {
      context.addIssue({
        code: "custom",
        path: ["featuredEffectId"],
        message: "Der sichtbare Effekt braucht eine Beschreibung.",
      });
    }
  }
};

export const channelStateDraftSchema = z
  .strictObject(stateContentShape)
  .superRefine(addStateContentIssues);

export const channelStateSchema = z
  .strictObject({
    ...stateContentShape,
    revision: z.number().int().min(1),
    overlayEnabled: z.boolean(),
    updatedAt: z.iso.datetime({ offset: true }),
    updatedBy: z.strictObject({
      twitchUserId: twitchUserIdSchema,
      displayName: normalizedText(1, 32),
    }),
  })
  .superRefine(addStateContentIssues);

export const releaseCapabilitiesSchema = z.strictObject({
  phase: z.enum(["v1a", "v1b"]),
  enabledThemes: z.array(themeIdSchema).min(1).max(THEME_IDS.length),
  petEditor: z.boolean(),
  groupEditor: z.boolean(),
  undo: z.boolean(),
});

export type ThemeId = (typeof THEME_IDS)[number];

export type TwitchUserId = z.infer<typeof twitchUserIdSchema>;
export type PortraitRef = z.infer<typeof portraitRefSchema>;
export type ActiveEffect = z.infer<typeof activeEffectSchema>;
export type GroupMember = z.infer<typeof groupMemberSchema>;
export type ChannelStateDraft = z.infer<typeof channelStateDraftSchema>;
export type ChannelState = z.infer<typeof channelStateSchema>;
export type ReleaseCapabilities = z.infer<typeof releaseCapabilitiesSchema>;
export type ReleaseStage = ReleaseCapabilities["phase"];

export const createDefaultState = (
  actor: { twitchUserId: string; displayName: string },
  updatedAt: string,
): ChannelState =>
  channelStateSchema.parse({
    schemaVersion: 1,
    revision: 1,
    overlayEnabled: true,
    themeId: "trail-wood",
    placement: { x: 12, y: 12, scale: 1 },
    player: {
      name: "Streamer",
      title: "IRL-Abenteuer",
      level: 30,
      portrait: { kind: "initials", text: "ST" },
      hpPercent: 100,
      resource: { name: "Energie", color: "#C2410C", percent: 0 },
    },
    pet: null,
    group: [],
    effects: [],
    featuredEffectId: null,
    updatedAt,
    updatedBy: actor,
  });

export const normalizeStateForRead = (
  state: ChannelState,
  now: Date = new Date(),
): ChannelState => {
  const effects = state.effects
    .filter(
      (effect) =>
        effect.expiresAt === null || Date.parse(effect.expiresAt) > now.getTime(),
    )
    .map((effect, order) => ({ ...effect, order }));
  const featuredEffectId = effects.some(
    (effect) => effect.id === state.featuredEffectId && effect.description !== null,
  )
    ? state.featuredEffectId
    : null;

  return channelStateSchema.parse({
    ...state,
    effects,
    featuredEffectId,
  });
};

export const getReleaseCapabilities = (
  stage: ReleaseStage,
): ReleaseCapabilities =>
  stage === "v1a"
    ? {
        phase: "v1a",
        enabledThemes: ["trail-wood"],
        petEditor: false,
        groupEditor: false,
        undo: false,
      }
    : {
        phase: "v1b",
        enabledThemes: [...THEME_IDS],
        petEditor: true,
        groupEditor: true,
        undo: true,
      };

export const validateDraftForRelease = (
  input: ChannelStateDraft,
  stage: ReleaseStage,
): ChannelStateDraft => {
  const draft = channelStateDraftSchema.parse(input);
  if (
    stage === "v1a" &&
    (draft.themeId !== "trail-wood" ||
      draft.pet !== null ||
      draft.group.length > 0)
  ) {
    throw new Error("V1a erlaubt nur das Standardtheme ohne Pet oder Gruppe.");
  }
  return draft;
};

export const stateByteLength = (state: ChannelState | ChannelStateDraft): number =>
  new TextEncoder().encode(JSON.stringify(state)).byteLength;
