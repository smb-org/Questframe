import { describe, expect, it } from "vitest";

import type { ChallengeUpdate } from "../../../src/shared/contracts/win-challenges";
import {
  accountForChallengeUpdate,
  parseChallengeUpdate,
  placementAtOriginFromLocation,
} from "../../../src/challenges/wire";

const update = (): ChallengeUpdate => ({
  eventSeq: 3,
  boardRevision: 2,
  settingsRevision: 1,
  settings: {
    styleId: "plain-list",
    themeMode: "inherit",
    surfaceOpacity: 100,
    headerStyle: "default",
    fontFamily: "theme",
    fontScale: 1,
    headerTitle: "CHALLENGES",
    penaltyText: "",
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
    timerRemainMs: null,
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

  it("akzeptiert 24 Stunden nur für den globalen Timer", () => {
    const current = update();
    const challenge = current.challenges[0];
    if (challenge === undefined) throw new Error("Test-Challenge fehlt.");
    const globalTimerUpdate = {
      ...current,
      settings: {
        ...current.settings,
        globalTimer: {
          totalMs: 86_400_000,
          endsAt: null,
          pausedRemainMs: 86_400_000,
        },
      },
      challenges: [{ ...challenge, timerTotalMs: 21_600_000 }],
    };
    expect(parseChallengeUpdate(globalTimerUpdate)).toEqual(globalTimerUpdate);
    expect(parseChallengeUpdate({
      ...globalTimerUpdate,
      challenges: [{ ...challenge, timerTotalMs: 21_600_001 }],
    })).toBeNull();
    expect(parseChallengeUpdate({
      ...globalTimerUpdate,
      settings: {
        ...globalTimerUpdate.settings,
        globalTimer: {
          totalMs: 86_400_001,
          endsAt: null,
          pausedRemainMs: null,
        },
      },
    })).toBeNull();
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

  it("validiert die eingefrorene Restzeit mit der Challenge-Grenze", () => {
    const current = update();
    const challenge = current.challenges[0];
    if (challenge === undefined) throw new Error("Test-Challenge fehlt.");
    const withRemain = { ...challenge, timerRemainMs: 3_600_000 };

    expect(parseChallengeUpdate({ ...current, challenges: [withRemain] })).toMatchObject({
      challenges: [withRemain],
    });
    expect(parseChallengeUpdate({
      ...current,
      challenges: [{ ...withRemain, timerRemainMs: -1 }],
    })).toBeNull();
    expect(parseChallengeUpdate({
      ...current,
      challenges: [{ ...withRemain, timerRemainMs: 21_600_001 }],
    })).toBeNull();
  });

  it("weist gleichzeitig laufende und pausierte Timer zurück", () => {
    const current = update();
    const challenge = current.challenges[0];
    if (challenge === undefined) throw new Error("Test-Challenge fehlt.");
    expect(parseChallengeUpdate({
      ...current,
      challenges: [{
        ...challenge,
        timerEndsAt: "2026-08-30T12:01:00.000Z",
        timerRemainMs: 1_000,
      }],
    })).toBeNull();
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

  it("weist einen unbekannten Kopfzeilen-Stil zurück", () => {
    expect(parseChallengeUpdate({
      ...update(),
      settings: { ...update().settings, headerStyle: "unknown" },
    })).toBeNull();
  });

  it("weist eine unbekannte Schriftart zurück", () => {
    expect(parseChallengeUpdate({
      ...update(),
      settings: { ...update().settings, fontFamily: "unknown" },
    })).toBeNull();
  });

  it("weist eine Schriftgröße außerhalb der Grenzen zurück", () => {
    expect(parseChallengeUpdate({
      ...update(),
      settings: { ...update().settings, fontScale: 2.05 },
    })).toBeNull();
  });

  it("akzeptiert eine leere Strafe und weist mehr als 80 Zeichen zurück", () => {
    expect(parseChallengeUpdate(update())).toEqual(update());
    expect(parseChallengeUpdate({
      ...update(),
      settings: { ...update().settings, penaltyText: "x".repeat(81) },
    })).toBeNull();
  });

  it("weist eine Flächenopazität außerhalb der fünf erlaubten Werte zurück", () => {
    for (const surfaceOpacity of [24, 50.5, 101]) {
      expect(parseChallengeUpdate({
        ...update(),
        settings: { ...update().settings, surfaceOpacity },
      })).toBeNull();
    }
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

describe("placementAtOriginFromLocation", () => {
  // jsdom navigiert bei einem Schreibzugriff auf location.search nicht; die
  // History-API setzt Query und Hash zuverlässig gemeinsam.
  const at = (relativeUrl: string): boolean => {
    window.history.replaceState({}, "", relativeUrl);
    return placementAtOriginFromLocation();
  };
  const withHash = (hash: string): boolean => at(`/overlay/challenges${hash}`);

  it("erkennt placement=origin neben dem Token", () => {
    expect(withHash("#token=abc&placement=origin")).toBe(true);
  });

  it("bleibt ohne das Flag bei der Kompositionsposition", () => {
    expect(withHash("#token=abc")).toBe(false);
  });

  it("akzeptiert keinen anderen Wert", () => {
    expect(withHash("#placement=center")).toBe(false);
  });

  it("nimmt das Flag auch aus der Query", () => {
    // Kein Geheimnis, und beim Zusammenbauen einer URL landet es leicht dort.
    expect(at("/overlay/challenges?placement=origin#token=abc")).toBe(true);
  });
});
