import { describe, expect, it } from "vitest";

import {
  challengeDefinitionFieldKeys,
  challengeSetV1FieldPolicy,
  challengeSetV1Schema,
  type ChallengeSetV1,
} from "../../../src/modules/win-challenges/contracts/schemas";

const now = "2026-09-14T12:00:00.000Z";

const challenge = {
  title: "Eine Challenge",
  kind: "counter" as const,
  unit: null,
  targetCount: 10,
  timerTotalMs: 60_000,
  sortOrder: 0,
  step: 1,
  hidden: false,
};

const setPayload = (overrides: Partial<ChallengeSetV1> = {}): ChallengeSetV1 => ({
  schemaVersion: 1,
  name: "Mein Set",
  createdAt: now,
  challenges: [challenge],
  ...overrides,
});

describe("Challenge-Set-V1-Vertrag", () => {
  it("akzeptiert die eingefrorenen Definitionsfelder und Metadaten", () => {
    expect(challengeSetV1Schema.safeParse(setPayload()).success).toBe(true);
  });

  it("weist eine falsche Version zurück", () => {
    expect(challengeSetV1Schema.safeParse({ ...setPayload(), schemaVersion: 2 }).success).toBe(false);
  });

  it("weist unbekannte Felder auf Datei- und Aufgabenebene zurück", () => {
    expect(challengeSetV1Schema.safeParse({ ...setPayload(), unexpected: true }).success).toBe(false);
    expect(challengeSetV1Schema.safeParse({
      ...setPayload(),
      challenges: [{ ...challenge, unexpected: true }],
    }).success).toBe(false);
  });

  it("weist Identitäten und Steuer-Keys zurück", () => {
    expect(challengeSetV1Schema.safeParse({
      ...setPayload(),
      challenges: [{ ...challenge, id: "server-id" }],
    }).success).toBe(false);
    expect(challengeSetV1Schema.safeParse({
      ...setPayload(),
      challenges: [{ ...challenge, clientId: "client-id" }],
    }).success).toBe(false);
    expect(challengeSetV1Schema.safeParse({
      ...setPayload(),
      challenges: [{ ...challenge, controlKey: "K7RP" }],
    }).success).toBe(false);
  });

  it("begrenzt ein Set auf 30 Aufgaben", () => {
    expect(challengeSetV1Schema.safeParse({
      ...setPayload(),
      challenges: Array.from({ length: 31 }, (_, index) => ({
        ...challenge,
        title: `Challenge ${String(index + 1)}`,
        sortOrder: index % 30,
      })),
    }).success).toBe(false);
  });

  it("erzwingt die Einheitenregeln des Aufgabentyps", () => {
    expect(challengeSetV1Schema.safeParse({
      ...setPayload(),
      challenges: [{ ...challenge, kind: "measure", targetCount: 10, unit: null }],
    }).success).toBe(false);
    expect(challengeSetV1Schema.safeParse({
      ...setPayload(),
      challenges: [{ ...challenge, kind: "counter", unit: "m" }],
    }).success).toBe(false);
  });

  it("validiert den Fortschrittsteil, ohne ihn zwingend zu machen", () => {
    const withProgress = setPayload({
      challenges: [{
        ...challenge,
        progress: {
          currentCount: 4,
          bestCount: 7,
          state: "active",
          timerRemainMs: -1_000,
          completedAt: null,
        },
      }],
    });

    expect(challengeSetV1Schema.safeParse(withProgress).success).toBe(true);
    expect(challengeSetV1Schema.safeParse({
      ...withProgress,
      challenges: [{ ...withProgress.challenges[0], progress: { currentCount: 4 } }],
    }).success).toBe(false);
  });

  it("erzwingt eine bewusste Entscheidung für jedes Definitionsfeld", () => {
    expect(Object.keys(challengeSetV1FieldPolicy).sort()).toEqual([...challengeDefinitionFieldKeys].sort());
  });
});
