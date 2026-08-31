import { describe, expect, it } from "vitest";

import type { ChallengeUpdate } from "../../../src/shared/contracts/win-challenges";
import {
  accountForChallengeUpdate,
  parseChallengeUpdate,
} from "../../../src/challenges/wire";

const update = (): ChallengeUpdate => ({
  eventSeq: 3,
  boardRevision: 2,
  settingsRevision: 1,
  settings: {
    styleId: "plain-list",
    themeMode: "inherit",
    surfaceMode: "surface",
    headerTitle: "CHALLENGES",
    effectsEnabled: true,
    maxVisible: 5,
    themeId: "trail-wood",
    globalTimer: null,
  },
  challenges: [{
    id: "challenge-1",
    title: "Eine Challenge",
    description: null,
    targetCount: 10,
    timerTotalMs: 10_000,
    sortOrder: 0,
    currentCount: 2,
    state: "pending",
    timerEndsAt: null,
    completedAt: null,
    createdAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  }],
  event: null,
});

describe("Challenge-Quelle-Wire", () => {
  it("nimmt eine gültige challenge_update-Nachricht an", () => {
    expect(parseChallengeUpdate(update())).toEqual(update());
  });

  it.each([
    ["fehlendes Feld", (() => {
      const { event, ...withoutEvent } = update();
      void event;
      return withoutEvent;
    })()],
    ["unbekanntes Feld", { ...update(), unexpected: true }],
    ["falscher Typ", { ...update(), eventSeq: "3" }],
    ["außerhalb der Prädikatsgrenze", { ...update(), settings: { ...update().settings, maxVisible: 11 } }],
  ] as const)("verwirft %s", (_label, value) => {
    expect(parseChallengeUpdate(value)).toBeNull();
  });

  it("feuert dieselbe eventSeq höchstens einmal", () => {
    const first = { ...update(), event: { scope: "challenge" as const, type: "completed" as const, challengeId: "challenge-1" } };
    const afterFirst = accountForChallengeUpdate(first, -1);
    const afterSecond = accountForChallengeUpdate(first, afterFirst.lastSeen);
    expect(afterFirst.shouldFire).toBe(true);
    expect(afterSecond.shouldFire).toBe(false);
    expect(afterSecond.lastSeen).toBe(first.eventSeq);
  });
});
