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
    overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end",
    globalTimerMode: "down",
    themeId: "trail-wood",
    globalTimer: null,
    placement: { x: 300, y: 8, scale: 1 },
  },
  challenges: [{
    id: "challenge-1",
    title: "Eine Challenge",
    targetCount: 10,
    timerTotalMs: 10_000,
    sortOrder: 0,
    hidden: false,
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

  it("weist das entfernte Beschreibungsfeld als unbekannten Wire-Key zurück", () => {
    const current = update();
    const challenge = current.challenges[0];
    if (challenge === undefined) throw new Error("Test-Challenge fehlt.");
    expect(parseChallengeUpdate({
      ...current,
      challenges: [{ ...challenge, description: "veraltet" }],
    })).toBeNull();
  });

  it("verlangt im Challenge-Key-Set das neue hidden-Feld", () => {
    const current = update();
    const challenge = current.challenges[0];
    if (challenge === undefined) throw new Error("Test-Challenge fehlt.");
    const oldChallenge = Object.fromEntries(
      Object.entries(challenge).filter(([key]) => key !== "hidden"),
    );
    const oldWire = { ...current, challenges: [oldChallenge] };

    expect(parseChallengeUpdate(current)).toEqual(current);
    expect(parseChallengeUpdate(oldWire)).toBeNull();
  });

  it("verlangt im Settings-Key-Set das Placement", () => {
    const withoutPlacement = {
      ...update(),
      settings: Object.fromEntries(
        Object.entries(update().settings).filter(([key]) => key !== "placement"),
      ),
    };
    expect(parseChallengeUpdate(update())).toEqual(update());
    expect(parseChallengeUpdate(withoutPlacement)).toBeNull();
  });

  it("verlangt im Settings-Key-Set den globalen Timer-Modus", () => {
    const withoutMode = {
      ...update(),
      settings: Object.fromEntries(
        Object.entries(update().settings).filter(([key]) => key !== "globalTimerMode"),
      ),
    };
    expect(parseChallengeUpdate(update())).toEqual(update());
    expect(parseChallengeUpdate(withoutMode)).toBeNull();
  });

  it("verlangt auch im Placement exakte Keys", () => {
    expect(parseChallengeUpdate({
      ...update(),
      settings: {
        ...update().settings,
        placement: { ...update().settings.placement, extra: true },
      },
    })).toBeNull();
  });

  it.each([
    ["fehlendes Feld", (() => {
      const { event, ...withoutEvent } = update();
      void event;
      return withoutEvent;
    })()],
    ["unbekanntes Feld", { ...update(), unexpected: true }],
    ["falscher Typ", { ...update(), eventSeq: "3" }],
    ["außerhalb der Prädikatsgrenze", { ...update(), settings: { ...update().settings, overflowMode: "other" } }],
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
