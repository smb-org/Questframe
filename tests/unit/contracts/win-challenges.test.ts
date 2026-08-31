import { describe, expect, it } from "vitest";

import {
  challengeDefinitionSchema,
  challengePlacementSchema,
  challengeSchema,
  commandSchema,
  settingsSchema,
} from "../../../src/modules/win-challenges/contracts/schemas";
import {
  isChallengeTitle,
  isCurrentCount,
  isDelta,
  isHeaderTitle,
  isInstant,
  isMaxVisible,
  isChallengePlacement,
  isPlacementScale,
  isPlacementX,
  isPlacementY,
  isSortOrder,
  isTargetCount,
  isTimerTotalMs,
} from "../../../src/modules/win-challenges/contracts/predicates";

const definition = {
  clientId: "client-1",
  title: "Eine Challenge",
  targetCount: 10,
  timerTotalMs: 10_000,
  sortOrder: 0,
};

const challenge = {
  id: "challenge-1",
  title: "Eine Challenge",
  targetCount: 10,
  timerTotalMs: 10_000,
  sortOrder: 0,
  hidden: false,
  currentCount: 0,
  state: "pending" as const,
  timerEndsAt: null,
  completedAt: null,
  createdAt: "2026-08-30T12:00:00.000Z",
  updatedAt: "2026-08-30T12:00:00.000Z",
};

const settings = {
  styleId: "plain-list" as const,
  themeMode: "inherit" as const,
  surfaceMode: "surface" as const,
  headerTitle: "CHALLENGES",
  effectsEnabled: true,
  maxVisible: 3,
  themeId: "trail-wood" as const,
  globalTimer: null,
  placement: { x: 300, y: 8, scale: 1 },
};

describe("Win-Challenges-Verträge", () => {
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

  it("hält alle Feldprädikate und die darüber gebauten Schemas gekoppelt", () => {
    const tables = [
      {
        name: "targetCount",
        predicate: isTargetCount,
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
        predicate: isCurrentCount,
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
          { value: -99, accepted: true },
          { value: 99, accepted: true },
          { value: 100, accepted: false },
        ],
      },
      {
        name: "maxVisible",
        predicate: isMaxVisible,
        schema: (value: unknown) => settingsSchema.safeParse({ ...settings, maxVisible: value }).success,
        values: [
          { value: 2, accepted: false },
          { value: 3, accepted: true },
          { value: 10, accepted: true },
          { value: 11, accepted: false },
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
});
