import { describe, expect, it } from "vitest";

import type { Challenge, GlobalTimer } from "../../../src/modules/win-challenges/contracts/schemas";
import {
  applyComplete,
  applyIncrement,
  applyReopen,
  applyStartGlobal,
  applyStartTimer,
  applyPauseGlobal,
  applyResetTimer,
  applyResetGlobal,
  applyStopTimer,
  deriveTimerState,
  type DomainNow,
} from "../../../src/modules/win-challenges/domain/timers";
import {
  mergeDefinition,
  normalizeSortOrder,
} from "../../../src/modules/win-challenges/domain/definitions";
import {
  challengeNumbers,
  formatChallengeStand,
  selectVisible,
} from "../../../src/modules/win-challenges/domain/visibility";
import {
  displayedMsFor,
  formatRemaining,
  remainingFor,
} from "../../../src/modules/win-challenges/ui/timer";

const now = "2026-08-30T12:00:00.000Z" as const;
const nowMilliseconds = Date.parse(now);

const makeChallenge = (overrides: Partial<Challenge> = {}): Challenge => ({
  id: "challenge-1",
  title: "Eine Challenge",
  kind: "counter",
  unit: null,
  controlKey: "K7RP",
  targetCount: 10,
  timerTotalMs: 10_000,
  sortOrder: 0,
  step: 1,
  bestCount: 0,
  hidden: false,
  currentCount: 0,
  state: "pending",
  timerEndsAt: null,
  timerRemainMs: null,
  completedAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const makeGlobalTimer = (overrides: Partial<GlobalTimer> = {}): GlobalTimer => ({
  totalMs: 60_000,
  endsAt: null,
  pausedRemainMs: null,
  ...overrides,
});

const definition = {
  id: "challenge-1",
  title: "Eine Challenge",
  kind: "counter",
  unit: null,
  targetCount: 10,
  timerTotalMs: 10_000,
  sortOrder: 0,
  step: 1,
  hidden: false,
} as const;

describe("Win-Challenges-Domain", () => {
  it("berechnet die angezeigte Timerzeit für runter- und hochzählend", () => {
    expect(displayedMsFor("down", 60_000, 12_345)).toBe(12_345);
    expect(displayedMsFor("up", 60_000, 12_345)).toBe(47_655);
    expect(displayedMsFor("up", 60_000, 0)).toBe(60_000);
    expect(displayedMsFor("down", 60_000, -1_000)).toBe(-1_000);
    expect(displayedMsFor("up", 60_000, -1_000)).toBe(60_000);
  });

  it("formatiert Überzeit mit Pluszeichen und behält sie bei laufenden und pausierten Timern", () => {
    expect(formatRemaining(-1)).toBe("+0:01");
    expect(formatRemaining(-61_000)).toBe("+1:01");
    expect(formatRemaining(-3_661_000)).toBe("+1:01:01");
    expect(remainingFor("2026-08-30T11:59:59.000Z", null, "expired", nowMilliseconds)).toBe(-1_000);
    expect(remainingFor(null, -1_000, "paused", nowMilliseconds)).toBe(-1_000);
  });

  it("leitet idle, running, expired und paused mit derselben Funktion ab", () => {
    expect(deriveTimerState(null, null, now)).toBe("idle");
    expect(deriveTimerState("2026-08-30T12:00:01.000Z", null, now)).toBe("running");
    expect(deriveTimerState("2026-08-30T11:59:59.000Z", null, now)).toBe("expired");
    expect(deriveTimerState(null, 5_000, now)).toBe("paused");
  });

  it("incrementiert positiv und negativ, klemmt und erzeugt bei Wirkung genau ein Event", () => {
    const positive = applyIncrement(makeChallenge({ currentCount: 2 }), 3, now);
    expect(positive.challenge.currentCount).toBe(5);
    expect(positive.event).toEqual({
      scope: "challenge",
      type: "progressed",
      challengeId: "challenge-1",
      delta: 3,
      previousCount: 2,
      currentCount: 5,
    });

    const negative = applyIncrement(makeChallenge({ currentCount: 2 }), -1, now);
    expect(negative.challenge.currentCount).toBe(1);
    expect(negative.event?.type).toBe("progressed");

    expect(applyIncrement(makeChallenge({ currentCount: 0 }), -1, now)).toEqual({
      challenge: makeChallenge({ currentCount: 0 }),
      event: null,
    });
    expect(applyIncrement(makeChallenge({ currentCount: 10 }), 1, now)).toEqual({
      challenge: makeChallenge({ currentCount: 10 }),
      event: null,
    });
    expect(applyIncrement(makeChallenge({ currentCount: 9 }), 99, now).challenge.currentCount).toBe(10);
  });

  it("schließt beim Ziel automatisch ab, ohne zusätzlich progressed zu feuern", () => {
    const result = applyIncrement(makeChallenge({
      currentCount: 9,
      state: "active",
      timerEndsAt: "2026-08-30T12:00:01.000Z",
      hidden: true,
    }), 1, now);
    expect(result.challenge.state).toBe("done");
    expect(result.challenge.timerEndsAt).toBeNull();
    expect(result.challenge).toMatchObject({ timerRemainMs: 1_000 });
    expect(result.challenge.completedAt).toBe(now);
    expect(result.challenge.hidden).toBe(false);
    expect(result.event).toEqual({
      scope: "challenge",
      type: "completed",
      challengeId: "challenge-1",
    });
  });

  it("lässt Messwerte mit der Schrittweite über ihr Ziel hinaus laufen", () => {
    const measure = makeChallenge({
      kind: "measure",
      unit: "m",
      targetCount: 1_500,
      step: 50,
      currentCount: 1_500,
    });

    const first = applyIncrement(measure, 50, now);
    expect(first.challenge).toMatchObject({ currentCount: 1_550, state: "pending" });
    expect(first.event).toMatchObject({ type: "progressed", delta: 50, currentCount: 1_550 });

    const overfulfilled = applyIncrement(first.challenge, 250, now);
    expect(overfulfilled.challenge).toMatchObject({ currentCount: 1_800, state: "pending" });
    expect(overfulfilled.event).toMatchObject({ type: "progressed", delta: 250, currentCount: 1_800 });
  });

  it("friert beim manuellen Abhaken die Restzeit eines laufenden Timers ein", () => {
    const result = applyComplete(makeChallenge({
      state: "active",
      timerEndsAt: "2026-08-30T12:03:12.000Z",
    }), now);

    expect(result.challenge).toMatchObject({
      state: "done",
      timerEndsAt: null,
      timerRemainMs: 192_000,
    });
  });

  it("friert beim Abhaken eines abgelaufenen Timers die Überzeit ein", () => {
    const result = applyComplete(makeChallenge({
      state: "active",
      timerEndsAt: "2026-08-30T11:59:59.000Z",
    }), now);

    expect(result.challenge).toMatchObject({ state: "done", timerEndsAt: null, timerRemainMs: -1_000 });
  });

  it("setzt beim Abhaken ohne laufenden Timer keine Restzeit", () => {
    const result = applyComplete(makeChallenge(), now);

    expect(result.challenge).toMatchObject({ state: "done", timerEndsAt: null, timerRemainMs: null });
  });

  it("bildet die Challenge-Übergangstabelle ab und behandelt wirkungslose Kommandos", () => {
    const completed = applyComplete(makeChallenge({
      state: "active",
      timerEndsAt: "2026-08-30T12:00:01.000Z",
      hidden: true,
    }), now);
    expect(completed.challenge).toMatchObject({ state: "done", timerEndsAt: null, hidden: false });
    expect(applyComplete(makeChallenge({ state: "done", completedAt: now }), now).event).toBeNull();

    const reopened = applyReopen(makeChallenge({ state: "done", completedAt: now, timerRemainMs: 3_120 }), now);
    expect(reopened.challenge.state).toBe("pending");
    expect(reopened.challenge.timerEndsAt).toBeNull();
    expect(reopened.challenge).toMatchObject({ timerRemainMs: 3_120 });
    expect(reopened.event?.type).toBe("reopened");
    expect(applyReopen(makeChallenge(), now).event).toBeNull();

    const started = applyStartTimer(makeChallenge(), now);
    expect(started.challenge.state).toBe("active");
    expect(started.challenge.timerEndsAt).toBe("2026-08-30T12:00:10.000Z");
    expect(started.event?.type).toBe("timer_started");

    const stopped = applyStopTimer(started.challenge, "2026-08-30T12:00:03.000Z");
    expect(stopped.challenge.state).toBe("pending");
    expect(stopped.challenge.timerEndsAt).toBeNull();
    expect(stopped.challenge.timerRemainMs).toBe(7_000);
    expect(stopped.event?.type).toBe("timer_stopped");
    const neverStarted = applyStopTimer(makeChallenge(), now);
    expect(neverStarted.event).toBeNull();
    expect(neverStarted.challenge.timerRemainMs).toBeNull();
    for (const timer of [
      { state: "active" as const, timerEndsAt: "2026-08-30T12:00:01.000Z", timerRemainMs: null },
      { state: "pending" as const, timerEndsAt: null, timerRemainMs: 3_120 },
      { state: "active" as const, timerEndsAt: "2026-08-30T11:59:59.000Z", timerRemainMs: null },
    ]) {
      const reset = applyResetTimer(makeChallenge(timer), now);
      expect(reset.challenge).toMatchObject({ state: "pending", timerEndsAt: null, timerRemainMs: null, updatedAt: now });
      expect(reset.event).toEqual({ scope: "challenge", type: "timer_stopped", challengeId: "challenge-1" });
    }
    const done = makeChallenge({ state: "done", timerRemainMs: 1_000 });
    expect(applyResetTimer(done, now)).toEqual({ challenge: done, event: null });
    expect(applyResetTimer(makeChallenge(), now)).toEqual({ challenge: makeChallenge(), event: null });
    expect(applyStartTimer(makeChallenge({ timerTotalMs: null }), now).error)
      .toBe("challenge_timer_not_configured");
  });

  it("öffnet Challenges mit abgelaufenem Timer ohne alten Zeitstempel wieder", () => {
    const reopened = applyReopen(
      makeChallenge({
        state: "done",
        completedAt: now,
        timerEndsAt: "2026-08-30T11:59:59.000Z",
      }),
      now,
    );

    expect(reopened.challenge).toMatchObject({
      state: "pending",
      timerEndsAt: null,
    });
  });

  it("startet einen abgelaufenen Challenge-Timer frisch", () => {
    const result = applyStartTimer(
      makeChallenge({
        state: "active",
        timerEndsAt: "2026-08-30T11:59:59.000Z",
      }),
      now,
    );

    expect(result.challenge.state).toBe("active");
    expect(result.challenge.timerEndsAt).toBe("2026-08-30T12:00:10.000Z");
    expect(Date.parse(result.challenge.timerEndsAt ?? "")).toBeGreaterThan(nowMilliseconds);
    expect(result.event?.type).toBe("timer_started");
  });

  it("startet einen laufenden Challenge-Timer nicht erneut", () => {
    const timerEndsAt = "2026-08-30T12:00:01.000Z";
    const challenge = makeChallenge({ state: "active", timerEndsAt });

    expect(applyStartTimer(challenge, now)).toEqual({
      challenge,
      event: null,
    });
  });

  it("startet einen pausierten Challenge-Timer mit der eingefrorenen Restzeit weiter", () => {
    const result = applyStartTimer(
      makeChallenge({ state: "pending", timerEndsAt: null, timerRemainMs: 3_120 }),
      now,
    );

    expect(result.challenge).toMatchObject({
      state: "active",
      timerEndsAt: "2026-08-30T12:00:03.120Z",
      timerRemainMs: null,
    });
    expect(result.event?.type).toBe("timer_started");
  });

  it("behält Überzeit beim Stoppen und Fortsetzen einer Challenge", () => {
    const stopped = applyStopTimer(makeChallenge({
      state: "active",
      timerEndsAt: "2026-08-30T11:59:59.000Z",
    }), now);

    expect(stopped.challenge).toMatchObject({
      state: "pending",
      timerEndsAt: null,
      timerRemainMs: -1_000,
    });

    const resumed = applyStartTimer(stopped.challenge, "2026-08-30T12:00:02.000Z");
    expect(resumed.challenge).toMatchObject({
      state: "active",
      timerEndsAt: "2026-08-30T12:00:01.000Z",
      timerRemainMs: null,
    });
  });

  it("behält beim Abhaken einer pausierten Challenge die eingefrorene Restzeit", () => {
    const result = applyComplete(
      makeChallenge({ state: "pending", timerEndsAt: null, timerRemainMs: 3_120 }),
      now,
    );

    expect(result.challenge).toMatchObject({ state: "done", timerEndsAt: null, timerRemainMs: 3_120 });
  });

  it("startet einen abgelaufenen globalen Timer frisch und läuft nicht ins Leere", () => {
    const result = applyStartGlobal(
      makeGlobalTimer({ endsAt: "2026-08-30T11:59:59.000Z" }),
      now,
    );
    expect(result.globalTimer?.endsAt).toBe("2026-08-30T12:01:00.000Z");
    expect(deriveTimerState(result.globalTimer?.endsAt ?? null, null, now)).toBe("running");
    expect(result.event?.type).toBe("global_started");
  });

  it("pausiert niemals ein bereits geleertes endsAt ein zweites Mal", () => {
    const running = makeGlobalTimer({ endsAt: "2026-08-30T12:01:00.000Z" });
    const paused = applyPauseGlobal(running, now);
    expect(paused.globalTimer).toMatchObject({ endsAt: null, pausedRemainMs: 60_000 });
    expect(applyPauseGlobal(paused.globalTimer, now)).toEqual({
      globalTimer: paused.globalTimer,
      event: null,
    });
  });

  it("pausiert und setzt einen globalen Timer in der Überzeit mit negativem Rest fort", () => {
    const paused = applyPauseGlobal(
      makeGlobalTimer({ endsAt: "2026-08-30T11:59:59.000Z" }),
      now,
    );
    expect(paused.globalTimer).toMatchObject({ endsAt: null, pausedRemainMs: -1_000 });
    expect(paused.event?.type).toBe("global_paused");

    const resumed = applyStartGlobal(paused.globalTimer, "2026-08-30T12:00:02.000Z");
    expect(resumed.globalTimer).toMatchObject({
      endsAt: "2026-08-30T12:00:01.000Z",
      pausedRemainMs: null,
    });
  });

  it("startet bei ausgeschaltetem globalem Timer nicht und setzt laufend/pausiert zurück", () => {
    expect(applyStartGlobal(null, now).error).toBe("global_timer_not_configured");
    expect(applyStartGlobal(makeGlobalTimer({ pausedRemainMs: 15_000 }), now).globalTimer?.endsAt)
      .toBe("2026-08-30T12:00:15.000Z");
    expect(applyPauseGlobal(makeGlobalTimer(), now).event).toBeNull();
    expect(applyResetGlobal(makeGlobalTimer({ endsAt: "2026-08-30T12:01:00.000Z" }), now).event?.type)
      .toBe("global_reset");
    expect(applyResetGlobal(makeGlobalTimer({ pausedRemainMs: 15_000 }), now).globalTimer)
      .toMatchObject({ endsAt: null, pausedRemainMs: null });
  });

  it("hält bei laufendem globalem Timer den Endzeitpunkt trotz geänderter Dauer", () => {
    const timer = makeGlobalTimer({ totalMs: 120_000, endsAt: "2026-08-30T12:01:00.000Z" });
    const started = applyStartGlobal({ ...timer, totalMs: 300_000 }, now);
    expect(started.event).toBeNull();
    expect(started.globalTimer).toEqual({
      totalMs: 300_000,
      endsAt: "2026-08-30T12:01:00.000Z",
      pausedRemainMs: null,
    });
  });

  it("merged Definitionen nach den vier Laufzeitregeln", () => {
    const timerRemoved = mergeDefinition(
      makeChallenge({ state: "active", timerEndsAt: "2026-08-30T12:01:00.000Z" }),
      { ...definition, timerTotalMs: null },
      now,
    );
    expect(timerRemoved).toMatchObject({ state: "pending", timerEndsAt: null, timerTotalMs: null });

    const expiredTimerRemoved = mergeDefinition(
      makeChallenge({ state: "active", timerEndsAt: "2026-08-30T11:59:59.000Z" }),
      { ...definition, timerTotalMs: null },
      now,
    );
    expect(expiredTimerRemoved).toMatchObject({
      state: "pending",
      timerEndsAt: null,
      timerTotalMs: null,
    });

    const timerChanged = mergeDefinition(
      makeChallenge({ state: "active", timerEndsAt: "2026-08-30T12:01:00.000Z", timerRemainMs: 5_000 }),
      { ...definition, timerTotalMs: 20_000 },
      now,
    );
    expect(timerChanged.timerEndsAt).toBe("2026-08-30T12:01:00.000Z");
    expect(timerChanged.timerRemainMs).toBeNull();

    const targetRemoved = mergeDefinition(
      makeChallenge({ currentCount: 7 }),
      { ...definition, targetCount: null },
      now,
    );
    expect(targetRemoved.currentCount).toBe(7);

    const targetLowered = mergeDefinition(
      makeChallenge({ currentCount: 7 }),
      { ...definition, targetCount: 4 },
      now,
    );
    expect(targetLowered.currentCount).toBe(4);

    const measureOverfulfilled = mergeDefinition(
      makeChallenge({ kind: "measure", unit: "m", targetCount: 1_500, currentCount: 1_800 }),
      { ...definition, kind: "measure", unit: "m", targetCount: 1_500 },
      now,
    );
    expect(measureOverfulfilled.currentCount).toBe(1_800);

    expect(mergeDefinition(
      makeChallenge({ state: "active" }),
      { ...definition, hidden: true },
      now,
    ).hidden).toBe(true);

    expect(mergeDefinition(
      makeChallenge({ state: "done", hidden: true, completedAt: now }),
      { ...definition, hidden: true },
      now,
    ).hidden).toBe(false);
  });

  it("entfernt beim Mergen den Timer einer abgehakten Challenge, ohne sie zurückzusetzen", () => {
    const completedTimerRemoved = mergeDefinition(
      makeChallenge({
        state: "done",
        completedAt: now,
        timerEndsAt: "2026-08-30T12:01:00.000Z",
      }),
      { ...definition, timerTotalMs: null },
      now,
    );

    expect(completedTimerRemoved).toMatchObject({
      state: "done",
      completedAt: now,
      timerEndsAt: null,
    });
  });

  it("setzt den Laufzeitstand bei einem Typwechsel vollständig zurück", () => {
    const activeTypeChange = mergeDefinition(
      makeChallenge({
        currentCount: 7,
        bestCount: 7,
        state: "active",
        timerEndsAt: "2026-08-30T12:01:00.000Z",
        completedAt: null,
      }),
      { ...definition, kind: "streak", targetCount: 5 },
      now,
    );

    expect(activeTypeChange).toMatchObject({
      kind: "streak",
      currentCount: 0,
      bestCount: 0,
      state: "pending",
      timerEndsAt: null,
      timerRemainMs: null,
      completedAt: null,
    });

    const pausedTypeChange = mergeDefinition(
      makeChallenge({
        state: "pending",
        timerEndsAt: null,
        timerRemainMs: 2_000,
        completedAt: now,
      }),
      { ...definition, kind: "tick", targetCount: null },
      now,
    );

    expect(pausedTypeChange).toMatchObject({
      kind: "tick",
      currentCount: 0,
      bestCount: 0,
      state: "pending",
      timerEndsAt: null,
      timerRemainMs: null,
      completedAt: null,
    });
  });

  it("lässt den Laufzeitstand bei unverändertem Typ und übererfüllte Messwerte unangetastet", () => {
    const counter = mergeDefinition(
      makeChallenge({ currentCount: 7, bestCount: 8 }),
      definition,
      now,
    );
    expect(counter).toMatchObject({ currentCount: 7, bestCount: 8, kind: "counter" });

    const measure = mergeDefinition(
      makeChallenge({ kind: "measure", unit: "m", targetCount: 1_500, currentCount: 1_800 }),
      { ...definition, kind: "measure", unit: "m", targetCount: 1_500 },
      now,
    );
    expect(measure).toMatchObject({ kind: "measure", currentCount: 1_800 });
  });

  it("sortiert ohne Schnitt, pinnt den laufenden Timer und reiht Erledigte ans Ende", () => {
    const challenges = [
      makeChallenge({ id: "first", sortOrder: 0 }),
      makeChallenge({ id: "timer", sortOrder: 1, timerEndsAt: "2026-08-30T12:01:00.000Z" }),
      makeChallenge({ id: "finished-1", sortOrder: 2, state: "done", completedAt: now }),
      makeChallenge({ id: "finished-2", sortOrder: 3, state: "done", completedAt: now }),
      makeChallenge({ id: "finished-3", sortOrder: 4, state: "done", completedAt: now }),
    ];
    const result = selectVisible(challenges, now);
    expect(result.map((challenge) => challenge.id)).toEqual([
      "timer",
      "first",
      "finished-1",
      "finished-2",
      "finished-3",
    ]);
  });

  it("gibt die vollständige geordnete Liste ohne Overflow-Schnitt zurück", () => {
    const open = Array.from({ length: 15 }, (_, index) =>
      makeChallenge({ id: `open-${String(index)}`, sortOrder: index }),
    );
    const finished = Array.from({ length: 5 }, (_, index) =>
      makeChallenge({
        id: `finished-${String(index)}`,
        sortOrder: 20 + index,
        state: "done",
        completedAt: now,
      }),
    );
    const result = selectVisible([...open, ...finished], now);
    expect(result).toHaveLength(20);
    expect(result.slice(0, 15).every((challenge) => challenge.state !== "done")).toBe(true);
    expect(selectVisible([
      makeChallenge({ state: "done", completedAt: "2026-08-30T11:59:51.999Z" }),
    ], now)).toHaveLength(1);
  });

  it("filtert versteckte Challenges und lässt sie für das Dock optional zu", () => {
    const hidden = makeChallenge({ id: "hidden", hidden: true, sortOrder: 0 });
    const open = makeChallenge({ id: "open", sortOrder: 1 });

    expect(selectVisible([hidden, open], now).map(({ id }) => id)).toEqual(["open"]);
    expect(selectVisible([hidden, open], now, { includeHidden: true }).map(({ id }) => id))
      .toEqual(["hidden", "open"]);
  });

  it("unterstützt Erledigt-Reihenfolge keep und Nummern unabhängig von Zustand und Pin", () => {
    const challenges = [
      makeChallenge({ id: "done-first", sortOrder: 0, state: "done", completedAt: now }),
      makeChallenge({ id: "open", sortOrder: 1 }),
      makeChallenge({ id: "done-last", sortOrder: 2, state: "done", completedAt: now }),
      makeChallenge({ id: "pinned", sortOrder: 3, state: "active", timerEndsAt: "2026-08-30T12:01:00.000Z" }),
      makeChallenge({ id: "hidden", sortOrder: 4, hidden: true }),
    ];

    expect(selectVisible(challenges, now, { doneOrder: "end" }).map(({ id }) => id))
      .toEqual(["pinned", "open", "done-first", "done-last"]);
    expect(selectVisible(challenges, now, { doneOrder: "keep" }).map(({ id }) => id))
      .toEqual(["pinned", "done-first", "open", "done-last"]);

    expect([...challengeNumbers(challenges).entries()]).toEqual([
      ["done-first", 1],
      ["open", 2],
      ["done-last", 3],
      ["pinned", 4],
    ]);
  });

  it("formatiert den Stand mit optionalem Zähler für versteckte Challenges", () => {
    expect(formatChallengeStand([
      makeChallenge({ state: "done" }),
      makeChallenge({ id: "open", sortOrder: 1 }),
    ])).toBe("1 / 2");
    expect(formatChallengeStand([
      makeChallenge({ state: "done" }),
      makeChallenge({ id: "hidden", hidden: true, sortOrder: 1 }),
      makeChallenge({ id: "open", sortOrder: 2 }),
    ])).toBe("1 / 2(+1)");
  });

  it("renormalisiert nach dem Löschen lückenlos auf 0..N-1", () => {
    const result = normalizeSortOrder([
      makeChallenge({ id: "c", sortOrder: 4 }),
      makeChallenge({ id: "a", sortOrder: 0 }),
      makeChallenge({ id: "b", sortOrder: 2 }),
    ]);
    expect(result.map((challenge) => [challenge.id, challenge.sortOrder])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("benötigt für neue Definitionen eine serverseitig vorgegebene ID", () => {
    const newDefinition = {
      clientId: "client-1",
      title: definition.title,
      kind: "counter",
      unit: null,
      targetCount: definition.targetCount,
      timerTotalMs: definition.timerTotalMs,
      sortOrder: definition.sortOrder,
      step: 1,
      hidden: false,
    } as const;
    expect(mergeDefinition(null, newDefinition, now, "generated-id", "K7RP")).toMatchObject({
      id: "generated-id",
      currentCount: 0,
      state: "pending",
    });
    expect(() => mergeDefinition(null, newDefinition, now)).toThrow();
  });

  it("verwendet keine implizite Zeitquelle", () => {
    const suppliedNow: DomainNow = nowMilliseconds;
    expect(applyStartTimer(makeChallenge(), suppliedNow).challenge.timerEndsAt)
      .toBe("2026-08-30T12:00:10.000Z");
  });
});
