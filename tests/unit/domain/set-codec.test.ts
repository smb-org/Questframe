import { describe, expect, it } from "vitest";

import {
  challengeSetV1Schema,
  type ChallengeBoardSnapshot,
  type Challenge,
} from "../../../src/modules/win-challenges/contracts/schemas";
import {
  decodeChallengeSet,
  encodeChallengeSet,
} from "../../../src/modules/win-challenges/domain/set-codec";

const now = "2026-09-14T12:00:00.000Z";
const snapshot = (challenge: Challenge): Pick<ChallengeBoardSnapshot, "challenges"> => ({
  challenges: [challenge],
});

const makeChallenge = (overrides: Partial<Challenge> = {}): Challenge => ({
  id: "server-id",
  title: "Eine Challenge",
  kind: "counter",
  unit: null,
  controlKey: "K7RP",
  targetCount: 10,
  timerTotalMs: 60_000,
  sortOrder: 0,
  step: 1,
  bestCount: 7,
  hidden: false,
  currentCount: 4,
  state: "pending",
  timerEndsAt: null,
  timerRemainMs: null,
  completedAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const encode = (challenge: Challenge, includeProgress = false) => encodeChallengeSet(
  snapshot(challenge),
  {
    name: "Mein Set",
    createdAt: now,
    now,
    includeProgress,
  },
);

describe("Challenge-Set-Codec", () => {
  it("wandelt ein Board in ein identitätsfreies Set und wieder in neue Definitionen um", () => {
    const original = makeChallenge({ kind: "measure", unit: "m", targetCount: 100, step: 5 });
    const payload = encode(original);
    const imported = decodeChallengeSet(payload);

    expect(payload.challenges[0]).toEqual({
      title: original.title,
      kind: original.kind,
      unit: original.unit,
      targetCount: original.targetCount,
      timerTotalMs: original.timerTotalMs,
      sortOrder: original.sortOrder,
      step: original.step,
      hidden: original.hidden,
    });
    expect(imported.definitions[0]).toMatchObject({
      title: original.title,
      kind: original.kind,
      unit: original.unit,
      targetCount: original.targetCount,
      timerTotalMs: original.timerTotalMs,
      sortOrder: original.sortOrder,
      step: original.step,
      hidden: original.hidden,
    });
    expect(imported.definitions[0]).toHaveProperty("clientId");
    expect(imported.definitions[0]).not.toHaveProperty("id");
    expect(imported.definitions[0]).not.toHaveProperty("controlKey");
    const importedDefinition = imported.definitions[0];
    if (importedDefinition === undefined || !("clientId" in importedDefinition)) {
      throw new Error("Der Import muss eine neue Client-ID vergeben.");
    }
    expect(importedDefinition.clientId).not.toBe(original.id);
  });

  it("nimmt den globalen Timer nicht in das Set auf", () => {
    const payload = encode(makeChallenge());

    expect(payload).not.toHaveProperty("globalTimer");
    expect(payload).not.toHaveProperty("settings");
  });

  it("vergibt für jede importierte Aufgabe eine eigene neue Client-ID", () => {
    const first = makeChallenge({ id: "server-id-1", sortOrder: 0 });
    const second = makeChallenge({ id: "server-id-2", sortOrder: 1, title: "Noch eine Challenge" });
    const payload = encodeChallengeSet(
      { challenges: [first, second] },
      { name: "Mein Set", createdAt: now, now },
    );

    const definitions = decodeChallengeSet(payload).definitions;
    const clientIds = definitions.map((definition) => {
      if (!("clientId" in definition)) throw new Error("Importierte Aufgabe ohne Client-ID.");
      return definition.clientId;
    });

    expect(new Set(clientIds).size).toBe(2);
    expect(clientIds.every((clientId) => clientId.startsWith("client-"))).toBe(true);
  });

  it("friert einen laufenden Timer als pausierte Restzeit ein", () => {
    const payload = encode(makeChallenge({
      state: "active",
      timerEndsAt: "2026-09-14T12:00:05.000Z",
    }), true);

    expect(payload.challenges[0]?.progress).toMatchObject({
      state: "pending",
      timerRemainMs: 5_000,
    });
  });

  it("behält negative Restzeit eines überzogenen laufenden Timers", () => {
    const payload = encode(makeChallenge({
      state: "active",
      timerEndsAt: "2026-09-14T11:59:59.000Z",
    }), true);

    expect(payload.challenges[0]?.progress?.timerRemainMs).toBe(-1_000);
  });

  it("speichert und lädt stark überzogene Restzeit vertragskonform", () => {
    const payload = encode(makeChallenge({
      currentCount: 4,
      bestCount: 7,
      state: "active",
      timerEndsAt: "2026-09-14T04:00:00.000Z",
    }), true);

    expect(payload.challenges[0]?.progress).toMatchObject({
      state: "pending",
      timerRemainMs: -21_600_000,
    });
    expect(challengeSetV1Schema.safeParse(payload).success).toBe(true);

    const restored = decodeChallengeSet(payload, { preserveProgress: true });
    expect(restored.progress).toEqual([{
      currentCount: 4,
      bestCount: 7,
      state: "pending",
      timerRemainMs: -21_600_000,
      completedAt: null,
    }]);
  });

  it("nimmt Fortschritt nur auf ausdrücklichen Schalter auf", () => {
    const withoutProgress = encode(makeChallenge(), false);
    const withProgress = encode(makeChallenge(), true);

    expect(withoutProgress.challenges[0]).not.toHaveProperty("progress");
    expect(withProgress.challenges[0]).toHaveProperty("progress");
  });

  it("verwirft Fortschritt beim Dateiweg, kann ihn für Runde 2 aber ausdrücklich durchreichen", () => {
    const payload = encode(makeChallenge({
      currentCount: 4,
      bestCount: 7,
      state: "active",
      timerEndsAt: "2026-09-14T12:00:05.000Z",
    }), true);

    const fromFile = decodeChallengeSet(payload);
    expect(fromFile.progress).toBeNull();
    expect(fromFile.definitions[0]).not.toHaveProperty("currentCount");

    const fromServerSet = decodeChallengeSet(payload, { preserveProgress: true });
    expect(fromServerSet.progress).toEqual([{
      currentCount: 4,
      bestCount: 7,
      state: "pending",
      timerRemainMs: 5_000,
      completedAt: null,
    }]);
  });
});
