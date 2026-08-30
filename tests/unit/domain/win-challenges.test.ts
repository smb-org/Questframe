import { describe, expect, it } from "vitest";

import type { Challenge, GlobalTimer } from "../../../src/modules/win-challenges/contracts/schemas";
import {
  applyComplete,
  applyIncrement,
  applyReopen,
  applyStartGlobal,
  applyStartTimer,
  applyPauseGlobal,
  applyResetGlobal,
  applyStopTimer,
  deriveTimerState,
  type DomainNow,
} from "../../../src/modules/win-challenges/domain/timers";
import {
  mergeDefinition,
  normalizeSortOrder,
} from "../../../src/modules/win-challenges/domain/definitions";
import { selectVisible } from "../../../src/modules/win-challenges/domain/visibility";

const now = "2026-08-30T12:00:00.000Z" as const;
const nowMilliseconds = Date.parse(now);

const makeChallenge = (overrides: Partial<Challenge> = {}): Challenge => ({
  id: "challenge-1",
  title: "Eine Challenge",
  description: null,
  targetCount: 10,
  timerTotalMs: 10_000,
  sortOrder: 0,
  currentCount: 0,
  state: "pending",
  timerEndsAt: null,
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
  description: null,
  targetCount: 10,
  timerTotalMs: 10_000,
  sortOrder: 0,
} as const;

describe("Win-Challenges-Domain", () => {
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
    const result = applyIncrement(makeChallenge({ currentCount: 9 }), 1, now);
    expect(result.challenge.state).toBe("done");
    expect(result.challenge.completedAt).toBe(now);
    expect(result.event).toEqual({
      scope: "challenge",
      type: "completed",
      challengeId: "challenge-1",
    });
  });

  it("bildet die Challenge-Übergangstabelle ab und behandelt wirkungslose Kommandos", () => {
    expect(applyComplete(makeChallenge(), now).challenge.state).toBe("done");
    expect(applyComplete(makeChallenge({ state: "done", completedAt: now }), now).event).toBeNull();

    const reopened = applyReopen(
      makeChallenge({ state: "done", completedAt: now, timerEndsAt: "2026-08-30T12:00:01.000Z" }),
      now,
    );
    expect(reopened.challenge.state).toBe("active");
    expect(reopened.event?.type).toBe("reopened");
    expect(applyReopen(makeChallenge(), now).event).toBeNull();

    const started = applyStartTimer(makeChallenge(), now);
    expect(started.challenge.state).toBe("active");
    expect(started.challenge.timerEndsAt).toBe("2026-08-30T12:00:10.000Z");
    expect(started.event?.type).toBe("timer_started");

    const stopped = applyStopTimer(started.challenge, now);
    expect(stopped.challenge.state).toBe("pending");
    expect(stopped.challenge.timerEndsAt).toBeNull();
    expect(stopped.event?.type).toBe("timer_stopped");
    expect(applyStopTimer(makeChallenge(), now).event).toBeNull();
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

  it("behält beim Wiederöffnen eines laufenden Timers den Endzeitpunkt", () => {
    const timerEndsAt = "2026-08-30T12:00:01.000Z";
    const reopened = applyReopen(
      makeChallenge({ state: "done", completedAt: now, timerEndsAt }),
      now,
    );

    expect(reopened.challenge).toMatchObject({
      state: "active",
      timerEndsAt,
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
      makeChallenge({ state: "active", timerEndsAt: "2026-08-30T12:01:00.000Z" }),
      { ...definition, timerTotalMs: 20_000 },
      now,
    );
    expect(timerChanged.timerEndsAt).toBe("2026-08-30T12:01:00.000Z");

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

  it("sortiert Sichtbarkeit nach Ordnung, pinnt den laufenden Timer und begrenzt korrekt", () => {
    const challenges = [
      makeChallenge({ id: "first", sortOrder: 0 }),
      makeChallenge({ id: "timer", sortOrder: 1, timerEndsAt: "2026-08-30T12:01:00.000Z" }),
      makeChallenge({ id: "finished-1", sortOrder: 2, state: "done", completedAt: now }),
      makeChallenge({ id: "finished-2", sortOrder: 3, state: "done", completedAt: now }),
      makeChallenge({ id: "finished-3", sortOrder: 4, state: "done", completedAt: now }),
    ];
    const result = selectVisible(challenges, 3, now);
    expect(result.challenges.map((challenge) => challenge.id)).toEqual([
      "timer",
      "first",
      "finished-1",
      "finished-2",
      "finished-3",
    ]);
    expect(result.remaining).toBe(0);
  });

  it("begrenzt offene und fertige Einträge unabhängig, mit hartem Gesamtlimit und Overflow", () => {
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
    const result = selectVisible([...open, ...finished], 10, now);
    expect(result.challenges).toHaveLength(12);
    expect(result.challenges.slice(0, 10).every((challenge) => challenge.state !== "done")).toBe(true);
    expect(result.remaining).toBe(5);
    expect(selectVisible([
      makeChallenge({ state: "done", completedAt: "2026-08-30T11:59:51.999Z" }),
    ], 3, now).challenges).toHaveLength(0);
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
      description: definition.description,
      targetCount: definition.targetCount,
      timerTotalMs: definition.timerTotalMs,
      sortOrder: definition.sortOrder,
    } as const;
    expect(mergeDefinition(null, newDefinition, now, "generated-id")).toMatchObject({
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
