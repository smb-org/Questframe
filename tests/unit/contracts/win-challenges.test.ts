import { describe, expect, it } from "vitest";

import {
  challengeDefinitionSchema,
  challengePlacementSchema,
  challengeSchema,
  commandSchema,
  globalTimerSchema,
  settingsSaveRequestSchema,
  settingsSchema,
} from "../../../src/modules/win-challenges/contracts/schemas";
import {
  GLOBAL_TIMER_UP_CAP_MS,
  MAX_MEASURE_COUNT,
  isChallengeTitle,
  isChallengeFontFamily,
  isChallengeFontScale,
  isChallengeSurfaceOpacity,
  isChallengeTextEmphasis,
  isCurrentCount,
  isCurrentCountForKind,
  isChallengeUnit,
  isChallengeStep,
  isDoneOrder,
  isDelta,
  isDeltaForKind,
  isGlobalTimerMode,
  isHeaderStyle,
  isHeaderTitle,
  isPenaltyLabel,
  isPenaltyText,
  isInstant,
  isGlobalTimerTotalMs,
  isMaxVisible,
  isNumbered,
  isOverflowMode,
  isOverflowTempo,
  isChallengePlacement,
  isPlacementScale,
  isPlacementX,
  isPlacementY,
  isSortOrder,
  isTargetCount,
  isTargetCountForKind,
  maxCountForKind,
  maxDeltaForKind,
  isTimerTotalMs,
  isTimerRemainMs,
} from "../../../src/modules/win-challenges/contracts/predicates";

const definition = {
  clientId: "client-1",
  title: "Eine Challenge",
  kind: "counter" as const,
  unit: null,
  targetCount: 10,
  timerTotalMs: 10_000,
  sortOrder: 0,
  step: 1,
};

const challenge = {
  id: "challenge-1",
  title: "Eine Challenge",
  kind: "counter" as const,
  unit: null,
  controlKey: "K7RP",
  targetCount: 10,
  timerTotalMs: 10_000,
  sortOrder: 0,
  step: 1,
  bestCount: 0,
  hidden: false,
  currentCount: 0,
  state: "pending" as const,
  timerEndsAt: null,
  timerRemainMs: null,
  completedAt: null,
  createdAt: "2026-08-30T12:00:00.000Z",
  updatedAt: "2026-08-30T12:00:00.000Z",
};

const settings = {
  styleId: "plain-list" as const,
  themeMode: "inherit" as const,
  surfaceOpacity: 100 as const,
  headerStyle: "default" as const,
  textEmphasis: "auto" as const,
  fontFamily: "theme" as const,
  fontScale: 1,
  headerTitle: "CHALLENGES",
  penaltyLabel: "STRAFE",
  penaltyText: "",
  effectsEnabled: true,
  maxVisible: 5,
  overflowMode: "cut" as const,
  overflowTempo: "medium" as const,
  numbered: false,
  doneOrder: "end" as const,
  globalTimerMode: "down" as const,
  themeId: "trail-wood" as const,
  globalTimer: null,
  placement: { x: 300, y: 8, scale: 1 },
};

describe("Win-Challenges-Verträge", () => {
  it("hält den Zahlenraum je Challenge-Typ an seiner Grenze", () => {
    const legacyKinds = ["tick", "counter", "streak"] as const;
    for (const kind of legacyKinds) {
      expect(maxCountForKind(kind)).toBe(999);
      expect(maxDeltaForKind(kind)).toBe(99);
      expect(isCurrentCountForKind(999, kind)).toBe(true);
      expect(isCurrentCountForKind(1_000, kind)).toBe(false);
      expect(isDeltaForKind(99, kind)).toBe(true);
      expect(isDeltaForKind(100, kind)).toBe(false);
    }

    expect(maxCountForKind("measure")).toBe(MAX_MEASURE_COUNT);
    expect(maxDeltaForKind("measure")).toBe(MAX_MEASURE_COUNT);
    expect(isTargetCount(MAX_MEASURE_COUNT)).toBe(true);
    expect(isTargetCount(MAX_MEASURE_COUNT + 1)).toBe(false);
    expect(isCurrentCount(MAX_MEASURE_COUNT)).toBe(true);
    expect(isCurrentCount(MAX_MEASURE_COUNT + 1)).toBe(false);
    expect(isDelta(MAX_MEASURE_COUNT)).toBe(true);
    expect(isDelta(MAX_MEASURE_COUNT + 1)).toBe(false);
    expect(isCurrentCountForKind(MAX_MEASURE_COUNT, "measure")).toBe(true);
    expect(isCurrentCountForKind(MAX_MEASURE_COUNT + 1, "measure")).toBe(false);
    expect(isDeltaForKind(MAX_MEASURE_COUNT, "measure")).toBe(true);
    expect(isDeltaForKind(MAX_MEASURE_COUNT + 1, "measure")).toBe(false);

    const challengeCases = [
      { kind: "tick" as const, unit: null, targetCount: null },
      { kind: "counter" as const, unit: null, targetCount: 999 },
      { kind: "streak" as const, unit: null, targetCount: 999 },
      { kind: "measure" as const, unit: "m", targetCount: MAX_MEASURE_COUNT },
    ];
    for (const challengeCase of challengeCases) {
      const boundary = maxCountForKind(challengeCase.kind);
      expect(challengeSchema.safeParse({
        ...challenge,
        ...challengeCase,
        bestCount: boundary,
        currentCount: boundary,
      }).success).toBe(true);
      expect(challengeSchema.safeParse({
        ...challenge,
        ...challengeCase,
        bestCount: boundary + 1,
      }).success).toBe(false);
      expect(challengeSchema.safeParse({
        ...challenge,
        ...challengeCase,
        currentCount: boundary + 1,
      }).success).toBe(false);
    }

    for (const kind of ["counter", "measure"] as const) {
      const boundary = maxCountForKind(kind);
      const unit = kind === "measure" ? "m" : null;
      expect(isTargetCountForKind(boundary, kind)).toBe(true);
      expect(isTargetCountForKind(boundary + 1, kind)).toBe(false);
      expect(challengeDefinitionSchema.safeParse({
        ...definition,
        kind,
        unit,
        targetCount: boundary,
      }).success).toBe(true);
      expect(challengeDefinitionSchema.safeParse({
        ...definition,
        kind,
        unit,
        targetCount: boundary + 1,
      }).success).toBe(false);
    }

    expect(challengeDefinitionSchema.safeParse({
      ...definition,
      kind: "counter",
      targetCount: MAX_MEASURE_COUNT,
    }).success).toBe(false);
  });

  it("validiert die Typregeln für Ziel und Einheit", () => {
    expect(challengeDefinitionSchema.safeParse({ ...definition, kind: "tick", targetCount: null }).success).toBe(true);
    expect(challengeDefinitionSchema.safeParse({ ...definition, kind: "tick", targetCount: 1 }).success).toBe(false);
    expect(challengeDefinitionSchema.safeParse({ ...definition, kind: "counter", targetCount: null }).success).toBe(true);
    expect(challengeDefinitionSchema.safeParse({ ...definition, kind: "streak", targetCount: 1 }).success).toBe(true);
    expect(challengeDefinitionSchema.safeParse({ ...definition, kind: "streak", targetCount: null }).success).toBe(false);
    expect(challengeDefinitionSchema.safeParse({
      ...definition,
      kind: "measure",
      targetCount: 1,
      unit: "  e\u0301  ",
    }).success).toBe(true);
    expect(challengeDefinitionSchema.parse({
      ...definition,
      kind: "measure",
      targetCount: 1,
      unit: "  e\u0301  ",
    }).unit).toBe("é");
    expect(challengeDefinitionSchema.safeParse({ ...definition, kind: "measure", targetCount: 1, unit: null }).success).toBe(false);
    expect(challengeDefinitionSchema.safeParse({ ...definition, kind: "counter", unit: "m" }).success).toBe(false);
  });

  it("hält Einheiten und Schrittweiten an den skalaren Prädikaten", () => {
    expect(isChallengeUnit("x".repeat(12))).toBe(true);
    expect(isChallengeUnit("x".repeat(13))).toBe(false);
    expect(isChallengeUnit("  ")).toBe(false);
    expect(isChallengeStep(1)).toBe(true);
    expect(isChallengeStep(1_000_000)).toBe(true);
    expect(isChallengeStep(1_000_001)).toBe(false);
    expect(isChallengeStep(0)).toBe(false);
    expect(challengeDefinitionSchema.safeParse({ ...definition, step: 1_000_000 }).success).toBe(true);
    expect(challengeDefinitionSchema.safeParse({ ...definition, step: 1_000_001 }).success).toBe(false);
  });

  it("erzwingt die kritische Titel-Grenzwerttabelle durch Prädikat und Schema", () => {
    const cases = [
      { label: "Emoji bis zur UTF-16-Grenze", value: "🧭".repeat(80), accepted: true },
      { label: "Emoji über die UTF-16-Grenze", value: "🧭".repeat(81), accepted: false },
      { label: "NFC-Form", value: "e\u0301", accepted: true },
      { label: "Leerstring", value: "", accepted: false },
      { label: "Maximum", value: "x".repeat(160), accepted: true },
      { label: "Maximum plus eins", value: "x".repeat(161), accepted: false },
    ];

    for (const testCase of cases) {
      const predicateAccepted = isChallengeTitle(testCase.value);
      const schemaAccepted = challengeDefinitionSchema.safeParse({
        ...definition,
        title: testCase.value,
      }).success;
      expect(predicateAccepted, testCase.label).toBe(testCase.accepted);
      expect(schemaAccepted, testCase.label).toBe(predicateAccepted);
    }
  });

  it("weist das entfernte Beschreibungsfeld in Definition und Snapshot zurück", () => {
    expect(challengeDefinitionSchema.safeParse({ ...definition, description: "veraltet" }).success).toBe(false);
    expect(challengeSchema.safeParse({ ...challenge, description: null }).success).toBe(false);
  });

  it("trennt die 6-Stunden-Challenge-Grenze von der 24-Stunden-Grenze des globalen Timers", () => {
    expect(isTimerTotalMs(21_600_000)).toBe(true);
    expect(isTimerTotalMs(21_600_001)).toBe(false);
    expect(isGlobalTimerTotalMs(GLOBAL_TIMER_UP_CAP_MS)).toBe(true);
    expect(isGlobalTimerTotalMs(GLOBAL_TIMER_UP_CAP_MS + 1)).toBe(false);
    expect(challengeDefinitionSchema.safeParse({
      ...definition,
      timerTotalMs: GLOBAL_TIMER_UP_CAP_MS,
    }).success).toBe(false);
    expect(globalTimerSchema.safeParse({
      totalMs: GLOBAL_TIMER_UP_CAP_MS,
      endsAt: null,
      pausedRemainMs: GLOBAL_TIMER_UP_CAP_MS,
    }).success).toBe(true);

    const { themeId: _themeId, globalTimer: _globalTimer, ...saveFields } = settings;
    void _themeId;
    void _globalTimer;
    expect(settingsSaveRequestSchema.safeParse({
      baseSettingsRevision: 1,
      ...saveFields,
      globalTimerTotalMs: GLOBAL_TIMER_UP_CAP_MS,
      placement: settings.placement,
    }).success).toBe(true);
    expect(settingsSaveRequestSchema.safeParse({
      baseSettingsRevision: 1,
      ...saveFields,
      globalTimerTotalMs: GLOBAL_TIMER_UP_CAP_MS + 1,
      placement: settings.placement,
    }).success).toBe(false);
  });

  it("validiert die eingefrorene Challenge-Restzeit mit derselben 6-Stunden-Grenze", () => {
    expect(isTimerRemainMs(null)).toBe(true);
    expect(isTimerRemainMs(0)).toBe(true);
    expect(isTimerRemainMs(21_600_000)).toBe(true);
    expect(isTimerRemainMs(-1)).toBe(true);
    expect(isTimerRemainMs(-21_600_000)).toBe(true);
    expect(isTimerRemainMs(-21_600_001)).toBe(false);
    expect(isTimerRemainMs(21_600_001)).toBe(false);
    expect(challengeSchema.safeParse({ ...challenge, timerRemainMs: 21_600_000 }).success).toBe(true);
    expect(challengeSchema.safeParse({ ...challenge, timerRemainMs: 21_600_001 }).success).toBe(false);
  });

  it("verbietet gleichzeitig laufende und pausierte Challenge-Timer", () => {
    expect(challengeSchema.safeParse({
      ...challenge,
      timerEndsAt: "2026-08-30T12:01:00.000Z",
      timerRemainMs: 1_000,
    }).success).toBe(false);
  });

  it("akzeptiert 20 sichtbare Zeilen und lehnt 21 ab", () => {
    expect(isMaxVisible(20)).toBe(true);
    expect(settingsSchema.safeParse({ ...settings, maxVisible: 20 }).success).toBe(true);
    expect(isMaxVisible(21)).toBe(false);
    expect(settingsSchema.safeParse({ ...settings, maxVisible: 21 }).success).toBe(false);
  });

  it("hält alle Feldprädikate und die darüber gebauten Schemas gekoppelt", () => {
    const tables = [
      {
        name: "targetCount",
        predicate: (value: unknown): value is number | null => isTargetCountForKind(value, "counter"),
        schema: (value: unknown) =>
          challengeDefinitionSchema.safeParse({ ...definition, targetCount: value }).success,
        values: [
          { value: null, accepted: true },
          { value: 1, accepted: true },
          { value: 999, accepted: true },
          { value: 1_000, accepted: false },
        ],
      },
      {
        name: "timerTotalMs",
        predicate: isTimerTotalMs,
        schema: (value: unknown) =>
          challengeDefinitionSchema.safeParse({ ...definition, timerTotalMs: value }).success,
        values: [
          { value: null, accepted: true },
          { value: 10_000, accepted: true },
          { value: 21_600_000, accepted: true },
          { value: 21_600_001, accepted: false },
        ],
      },
      {
        name: "sortOrder",
        predicate: isSortOrder,
        schema: (value: unknown) =>
          challengeDefinitionSchema.safeParse({ ...definition, sortOrder: value }).success,
        values: [
          { value: 0, accepted: true },
          { value: 29, accepted: true },
          { value: 30, accepted: false },
        ],
      },
      {
        name: "currentCount",
        predicate: (value: unknown): value is number => isCurrentCountForKind(value, "counter"),
        schema: (value: unknown) => challengeSchema.safeParse({ ...challenge, currentCount: value }).success,
        values: [
          { value: 0, accepted: true },
          { value: 999, accepted: true },
          { value: 1_000, accepted: false },
        ],
      },
      {
        name: "delta",
        predicate: isDelta,
        schema: (value: unknown) =>
          commandSchema.safeParse({
            commandId: "dc95708a-645a-4bc0-9ca3-7ffbd42e6662",
            scope: "challenge",
            type: "increment",
            challengeId: "challenge-1",
            delta: value,
          }).success,
        values: [
          { value: -MAX_MEASURE_COUNT, accepted: true },
          { value: MAX_MEASURE_COUNT, accepted: true },
          { value: MAX_MEASURE_COUNT + 1, accepted: false },
        ],
      },
      {
        name: "overflowMode",
        predicate: isOverflowMode,
        schema: (value: unknown) => settingsSchema.safeParse({ ...settings, overflowMode: value }).success,
        values: [
          { value: "cut", accepted: true },
          { value: "page", accepted: true },
          { value: "scroll", accepted: true },
          { value: "other", accepted: false },
        ],
      },
      {
        name: "overflowTempo",
        predicate: isOverflowTempo,
        schema: (value: unknown) => settingsSchema.safeParse({ ...settings, overflowTempo: value }).success,
        values: [
          { value: "slow", accepted: true },
          { value: "medium", accepted: true },
          { value: "fast", accepted: true },
          { value: "other", accepted: false },
        ],
      },
      {
        name: "numbered",
        predicate: isNumbered,
        schema: (value: unknown) => settingsSchema.safeParse({ ...settings, numbered: value }).success,
        values: [
          { value: true, accepted: true },
          { value: false, accepted: true },
          { value: "true", accepted: false },
        ],
      },
      {
        name: "doneOrder",
        predicate: isDoneOrder,
        schema: (value: unknown) => settingsSchema.safeParse({ ...settings, doneOrder: value }).success,
        values: [
          { value: "end", accepted: true },
          { value: "keep", accepted: true },
          { value: "front", accepted: false },
        ],
      },
      {
        name: "globalTimerMode",
        predicate: isGlobalTimerMode,
        schema: (value: unknown) => settingsSchema.safeParse({ ...settings, globalTimerMode: value }).success,
        values: [
          { value: "down", accepted: true },
          { value: "up", accepted: true },
          { value: "sideways", accepted: false },
        ],
      },
      {
        name: "headerTitle",
        predicate: isHeaderTitle,
        schema: (value: unknown) => settingsSchema.safeParse({ ...settings, headerTitle: value }).success,
        values: [
          { value: "", accepted: false },
          { value: "e\u0301", accepted: true },
          { value: "x".repeat(24), accepted: true },
          { value: "x".repeat(25), accepted: false },
        ],
      },
      {
        name: "penaltyLabel",
        predicate: isPenaltyLabel,
        schema: (value: unknown) => settingsSchema.safeParse({ ...settings, penaltyLabel: value }).success,
        values: [
          { value: "", accepted: true },
          { value: "  ", accepted: true },
          { value: "x".repeat(24), accepted: true },
          { value: "x".repeat(25), accepted: false },
        ],
      },
      {
        name: "penaltyText",
        predicate: isPenaltyText,
        schema: (value: unknown) => settingsSchema.safeParse({ ...settings, penaltyText: value }).success,
        values: [
          { value: "", accepted: true },
          { value: "  ", accepted: true },
          { value: "x".repeat(80), accepted: true },
          { value: "x".repeat(81), accepted: false },
        ],
      },
      {
        name: "headerStyle",
        predicate: isHeaderStyle,
        schema: (value: unknown) => settingsSchema.safeParse({ ...settings, headerStyle: value }).success,
        values: [
          { value: "default", accepted: true },
          { value: "inverted", accepted: true },
          { value: "unknown", accepted: false },
        ],
      },
      {
        name: "textEmphasis",
        predicate: isChallengeTextEmphasis,
        schema: (value: unknown) => settingsSchema.safeParse({ ...settings, textEmphasis: value }).success,
        values: [
          { value: "auto", accepted: true },
          { value: "strong", accepted: true },
          { value: "plain", accepted: true },
          { value: "unknown", accepted: false },
        ],
      },
      {
        name: "fontFamily",
        predicate: isChallengeFontFamily,
        schema: (value: unknown) => settingsSchema.safeParse({ ...settings, fontFamily: value }).success,
        values: [
          { value: "theme", accepted: true },
          { value: "atkinson", accepted: true },
          { value: "serif", accepted: true },
          { value: "sans", accepted: true },
          { value: "mono", accepted: true },
          { value: "unknown", accepted: false },
        ],
      },
      {
        name: "fontScale",
        predicate: isChallengeFontScale,
        schema: (value: unknown) => settingsSchema.safeParse({ ...settings, fontScale: value }).success,
        values: [
          { value: 0.75, accepted: true },
          { value: 1, accepted: true },
          { value: 1.5, accepted: true },
          { value: 2, accepted: true },
          { value: 0.7, accepted: false },
          { value: 1.01, accepted: false },
          { value: 2.05, accepted: false },
        ],
      },
      {
        name: "instant",
        predicate: isInstant,
        schema: (value: unknown) => challengeSchema.safeParse({ ...challenge, createdAt: value }).success,
        values: [
          { value: "2026-08-30T12:00:00.000Z", accepted: true },
          { value: "2026-08-30T12:00:00+02:00", accepted: true },
          { value: "not-an-instant", accepted: false },
        ],
      },
    ] as const;

    for (const table of tables) {
      for (const testCase of table.values) {
        const predicateAccepted = table.predicate(testCase.value);
        expect(predicateAccepted, `${table.name}: ${String(testCase.value)}`).toBe(testCase.accepted);
        expect(table.schema(testCase.value), `${table.name}: Schema`).toBe(predicateAccepted);
      }
    }
  });

  it("akzeptiert beide Command-DTO-Formen und lehnt unbekannte Felder ab", () => {
    expect(commandSchema.parse({
      commandId: "dc95708a-645a-4bc0-9ca3-7ffbd42e6662",
      scope: "challenge",
      type: "complete",
      challengeId: "challenge-1",
    })).toMatchObject({ scope: "challenge", type: "complete" });
    expect(commandSchema.parse({
      commandId: "dc95708a-645a-4bc0-9ca3-7ffbd42e6662",
      scope: "challenge",
      type: "resetTimer",
      challengeId: "challenge-1",
    })).toMatchObject({ scope: "challenge", type: "resetTimer" });
    expect(commandSchema.parse({
      commandId: "dc95708a-645a-4bc0-9ca3-7ffbd42e6662",
      scope: "global",
      type: "startGlobalTimer",
    })).toMatchObject({ scope: "global", type: "startGlobalTimer" });
    expect(() => commandSchema.parse({
      commandId: "dc95708a-645a-4bc0-9ca3-7ffbd42e6662",
      scope: "global",
      type: "resetGlobalTimer",
      challengeId: "challenge-1",
    })).toThrow();
  });

  it("setzt hidden bei alten Board-Definitionen auf false und validiert den Boolean", () => {
    expect(challengeDefinitionSchema.parse(definition)).toMatchObject({ hidden: false });
    expect(challengeDefinitionSchema.safeParse({ ...definition, hidden: true }).success).toBe(true);
    expect(challengeDefinitionSchema.safeParse({ ...definition, hidden: "yes" }).success).toBe(false);
  });

  it("validiert das Challenge-Placement und setzt den Default", () => {
    const values = [
      { value: { x: 0, y: 0, scale: 0.75 }, accepted: true },
      { value: { x: 384, y: 216, scale: 2 }, accepted: true },
      { value: { x: -1, y: 8, scale: 1 }, accepted: false },
      { value: { x: 300, y: 217, scale: 1 }, accepted: false },
      { value: { x: 300, y: 8, scale: 0.74 }, accepted: false },
      { value: { x: 300, y: 8, scale: 1.001 }, accepted: false },
    ];

    for (const { value, accepted } of values) {
      expect(isChallengePlacement(value)).toBe(accepted);
      expect(challengePlacementSchema.safeParse(value).success).toBe(accepted);
    }
    expect(isPlacementX(384)).toBe(true);
    expect(isPlacementY(216)).toBe(true);
    expect(isPlacementScale(0.75)).toBe(true);
    expect(settingsSchema.parse({ ...settings, placement: undefined }).placement).toEqual({
      x: 300,
      y: 8,
      scale: 1,
    });
  });

  it("verlangt den Timer-Modus im Settings-Schema", () => {
    expect(settingsSchema.safeParse(settings).success).toBe(true);
    expect(settingsSchema.safeParse({ ...settings, globalTimerMode: undefined }).success).toBe(false);
  });

  it("akzeptiert alle Admin-Skalierungsstufen trotz Float-Rundungsfehlern", () => {
    const accepted = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
    const rejected = [0.5, 2.25, 1.005];

    for (const scale of accepted) {
      expect(isPlacementScale(scale)).toBe(true);
    }
    for (const scale of rejected) {
      expect(isPlacementScale(scale)).toBe(false);
    }
  });

  it("akzeptiert für die Flächenopazität nur die fünf Prozentwerte", () => {
    for (const value of [0, 25, 50, 75, 100]) {
      expect(isChallengeSurfaceOpacity(value)).toBe(true);
      expect(settingsSchema.safeParse({ ...settings, surfaceOpacity: value }).success).toBe(true);
    }

    for (const value of [-1, 24, 50.5, 101, "50"]) {
      expect(isChallengeSurfaceOpacity(value)).toBe(false);
      expect(settingsSchema.safeParse({ ...settings, surfaceOpacity: value }).success).toBe(false);
    }
  });
});
