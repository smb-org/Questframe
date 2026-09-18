import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/channel/migrations";
import { createSqlStorageChallengeRepository } from "../../src/modules/win-challenges/adapters/sql-storage-challenge-repository";
import type { Challenge, ChallengeDefinition } from "../../src/modules/win-challenges/contracts/schemas";
import { createWinChallenges, hashChallengeCommand } from "../../src/modules/win-challenges/service/commands";
import { bootstrapResponseSchema, saveResponseSchema } from "../../src/shared/contracts/api";

const origin = "http://localhost:5173";
const tabId = "challenge-api-test";
const now = "2026-08-31T12:00:00.000Z";
const stub = env.CHANNEL.get(env.CHANNEL.idFromName(`channel:${env.BROADCASTER_ID}`));

let cookie = "";
let csrfToken = "";

const fetchWorker = (path: string, init?: RequestInit): Promise<Response> =>
  exports.default.fetch(new Request(`http://localhost${path}`, init));

const authenticatedHeaders = (): HeadersInit => ({
  cookie,
  origin,
  "x-editor-tab": tabId,
  "x-csrf-token": csrfToken,
  "content-type": "application/json",
});

const commandId = (): string => crypto.randomUUID();

const definition = (title = "Eine Challenge"): ChallengeDefinition => ({
  clientId: `client-${title}`,
  title,
  kind: "counter",
  unit: null,
  targetCount: 3,
  timerTotalMs: 10_000,
  sortOrder: 0,
  step: 1,
  hidden: false,
});

type CommandResponseBody = {
  eventSeq: number;
  replayed: boolean;
  challenge?: Challenge;
  settings?: {
    globalTimer: {
      totalMs: number;
      endsAt: string | null;
      pausedRemainMs: number | null;
    } | null;
  };
};

const expectExactKeys = (value: object, keys: readonly string[]): void => {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
};

const resetModuleTables = async (): Promise<void> => {
  await runInDurableObject(stub, (_instance, state) => {
    runMigrations(state.storage.sql, "worker-test-api");
    state.storage.sql.exec("DELETE FROM wc_challenges");
    state.storage.sql.exec("DELETE FROM wc_commands");
    state.storage.sql.exec("DELETE FROM wc_sets");
    state.storage.sql.exec(
      `UPDATE wc_meta SET
        event_seq = 0, board_revision = 1, settings_revision = 1,
        style_id = 'plain-list', theme_mode = 'own', surface_opacity = 100, header_style = 'default',
        header_title = 'CHALLENGES', penalty_text = '', effects_enabled = 1, max_visible = 5,
        overflow_mode = 'cut', overflow_tempo = 'medium', numbered = 0, key_visible = 0, done_order = 'end',
        placement_x = 300, placement_y = 8, placement_scale = 1,
        global_timer_total_ms = NULL, global_timer_ends_at = NULL,
        global_timer_paused_remain_ms = NULL
       WHERE singleton = 1`,
    );
  });
};

const refreshCsrf = async (): Promise<void> => {
  const response = await fetchWorker("/api/editor/bootstrap", {
    headers: { cookie, "x-editor-tab": tabId },
  });
  const body = await response.json<{ csrfToken: string }>();
  csrfToken = body.csrfToken;
};

const saveBoard = async (
  challenges: readonly ChallengeDefinition[],
  baseBoardRevision = 1,
): Promise<Response> =>
  fetchWorker("/api/challenges/board", {
    method: "PUT",
    headers: authenticatedHeaders(),
    body: JSON.stringify({ baseBoardRevision, challenges }),
  });

describe("Win-Challenges-API", () => {
  beforeAll(async () => {
    const login = await fetchWorker("/auth/dev", { redirect: "manual" });
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    await refreshCsrf();
  });

  beforeEach(async () => {
    await resetModuleTables();
    await refreshCsrf();
  });

  it("führt alle neun Mutationen über den Service mit dem HTTP-Vertrag aus", async () => {
    const board = await saveBoard([definition()]);
    expect(board.status).toBe(200);
    const boardBody = await board.json<{
      snapshot: { boardRevision: number; challenges: Challenge[] };
    }>();
    const challenge = boardBody.snapshot.challenges[0];
    if (challenge === undefined) throw new Error("Challenge fehlt.");

    const run = async (
      body: Record<string, unknown>,
      keys: readonly string[],
    ): Promise<CommandResponseBody> => {
      const response = await fetchWorker("/api/challenges/commands", {
        method: "POST",
        headers: authenticatedHeaders(),
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      const result = await response.json<CommandResponseBody>();
      expectExactKeys(result, keys);
      return result;
    };

    const increment = await run({
      commandId: commandId(),
      scope: "challenge",
      type: "increment",
      challengeId: challenge.id,
      delta: 1,
    }, ["eventSeq", "replayed", "challenge"]);
    expect(increment.challenge?.currentCount).toBe(1);

    const complete = await run({
      commandId: commandId(),
      scope: "challenge",
      type: "complete",
      challengeId: challenge.id,
    }, ["eventSeq", "replayed", "challenge"]);
    expect(complete.challenge?.state).toBe("done");

    const reopen = await run({
      commandId: commandId(),
      scope: "challenge",
      type: "reopen",
      challengeId: challenge.id,
    }, ["eventSeq", "replayed", "challenge"]);
    expect(reopen.challenge?.state).toBe("pending");

    const startTimer = await run({
      commandId: commandId(),
      scope: "challenge",
      type: "startTimer",
      challengeId: challenge.id,
    }, ["eventSeq", "replayed", "challenge"]);
    expect(startTimer.challenge?.state).toBe("active");

    const stopTimer = await run({
      commandId: commandId(),
      scope: "challenge",
      type: "stopTimer",
      challengeId: challenge.id,
    }, ["eventSeq", "replayed", "challenge"]);
    expect(stopTimer.challenge?.state).toBe("pending");

    const resetTimer = await run({
      commandId: commandId(),
      scope: "challenge",
      type: "resetTimer",
      challengeId: challenge.id,
    }, ["eventSeq", "replayed", "challenge"]);
    expect(resetTimer.challenge).toMatchObject({ state: "pending", timerEndsAt: null, timerRemainMs: null });

    const settingsResponse = await fetchWorker("/api/challenges/settings", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        baseSettingsRevision: 1,
        styleId: "plain-list",
        themeMode: "own",
        surfaceOpacity: 100,
        headerStyle: "default",
        textEmphasis: "auto",
        fontFamily: "theme",
        fontScale: 1,
        headerTitle: "CHALLENGES",
        penaltyLabel: "STRAFE",
        penaltyText: "",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut", overflowTempo: "medium", numbered: false, keyVisible: false, doneOrder: "end", globalTimerMode: "down",
        globalTimerTotalMs: 60_000,
        placement: { x: 300, y: 8, scale: 1 },
      }),
    });
    expect(settingsResponse.status).toBe(200);

    const startGlobalTimer = await run({
      commandId: commandId(),
      scope: "global",
      type: "startGlobalTimer",
    }, ["eventSeq", "replayed", "settings"]);
    const startedSettings = startGlobalTimer.settings;
    if (startedSettings === undefined) throw new Error("Settings-Antwort fehlt.");
    const startedGlobalTimer = startedSettings.globalTimer;
    expect(startedGlobalTimer).not.toBeNull();
    if (startedGlobalTimer === null || typeof startedGlobalTimer !== "object") {
      throw new Error("Globaler Timer wurde nicht gestartet.");
    }
    expect(typeof startedGlobalTimer.endsAt).toBe("string");

    const pauseGlobalTimer = await run({
      commandId: commandId(),
      scope: "global",
      type: "pauseGlobalTimer",
    }, ["eventSeq", "replayed", "settings"]);
    const pausedSettings = pauseGlobalTimer.settings;
    if (pausedSettings === undefined) throw new Error("Settings-Antwort fehlt.");
    const pausedGlobalTimer = pausedSettings.globalTimer;
    expect(pausedGlobalTimer).not.toBeNull();
    if (pausedGlobalTimer === null || typeof pausedGlobalTimer !== "object") {
      throw new Error("Globaler Timer wurde nicht pausiert.");
    }
    expect(typeof pausedGlobalTimer.pausedRemainMs).toBe("number");

    const resetGlobalTimer = await run({
      commandId: commandId(),
      scope: "global",
      type: "resetGlobalTimer",
    }, ["eventSeq", "replayed", "settings"]);
    const resetSettings = resetGlobalTimer.settings;
    if (resetSettings === undefined) throw new Error("Settings-Antwort fehlt.");
    expect(resetSettings.globalTimer).toMatchObject({
      totalMs: 60_000,
      endsAt: null,
      pausedRemainMs: null,
    });
    expect(resetGlobalTimer.eventSeq).toBe(9);
  });

  it("liefert Replay und Idempotenz-Mismatch ohne zweite Mutation", async () => {
    const board = await saveBoard([definition()]);
    const body = await board.json<{ snapshot: { challenges: Challenge[] } }>();
    const challenge = body.snapshot.challenges[0];
    if (challenge === undefined) throw new Error("Challenge fehlt.");
    const firstRequest = {
      commandId: commandId(),
      scope: "challenge",
      type: "increment",
      challengeId: challenge.id,
      delta: 1,
    } as const;

    const first = await fetchWorker("/api/challenges/commands", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify(firstRequest),
    });
    const replay = await fetchWorker("/api/challenges/commands", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify(firstRequest),
    });
    const mismatch = await fetchWorker("/api/challenges/commands", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ ...firstRequest, delta: 2 }),
    });
    const firstBody = await first.json<{ eventSeq: number; replayed: boolean; challenge: Challenge }>();
    const replayBody = await replay.json<{ eventSeq: number; replayed: boolean; challenge: Challenge }>();
    const mismatchBody = await mismatch.json<{ error: { code: string } }>();

    expect(firstBody).toMatchObject({ eventSeq: 1, replayed: false, challenge: { currentCount: 1 } });
    expect(replayBody).toMatchObject({ eventSeq: 1, replayed: true, challenge: { currentCount: 1 } });
    expectExactKeys(firstBody, ["eventSeq", "replayed", "challenge"]);
    expectExactKeys(replayBody, ["eventSeq", "replayed", "challenge"]);
    expect(mismatch.status).toBe(409);
    expect(mismatchBody.error.code).toBe("idempotency_mismatch");

    const measuredCommand = {
      commandId: commandId(),
      scope: "challenge",
      type: "increment",
      challengeId: challenge.id,
      delta: 1,
    } as const;
    const measuredRequestHash = await hashChallengeCommand(measuredCommand);
    const measured = await runInDurableObject(stub, (_instance, state) => {
      const repository = createSqlStorageChallengeRepository({
        sql: state.storage.sql,
        transactionSync: state.storage.transactionSync.bind(state.storage),
      });
      const service = createWinChallenges({ repository, clock: () => now });
      return repository.measure(() =>
        service.executeCommandWithHash(measuredCommand, measuredRequestHash),
      );
    });
    expect(measured.rowsWritten).toBeGreaterThan(0);
    const measuredReplay = await runInDurableObject(stub, (_instance, state) => {
      const repository = createSqlStorageChallengeRepository({
        sql: state.storage.sql,
        transactionSync: state.storage.transactionSync.bind(state.storage),
      });
      const replayNow = new Date(Date.parse(now) + 25 * 60 * 60 * 1_000).toISOString();
      const service = createWinChallenges({ repository, clock: () => replayNow });
      return repository.measure(() =>
        service.executeCommandWithHash(measuredCommand, measuredRequestHash),
      );
    });
    expect(measuredReplay.rowsWritten).toBe(0);
  });

  it("akzeptiert das entfernte Beschreibungsfeld nicht mehr im Board-API", async () => {
    const response = await saveBoard([
      { ...definition(), description: "veraltetes Feld" } as unknown as ChallengeDefinition,
    ]);
    expect(response.status).toBe(422);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe("validation_failed");
  });

  it("liefert Konflikte mit dem aktuellen Board- und Settings-Snapshot", async () => {
    const firstBoard = await saveBoard([definition("Erste")]);
    const firstBoardBody = await firstBoard.json<{
      snapshot: { boardRevision: number; settingsRevision: number; challenges: Challenge[] };
    }>();
    const staleBoard = await saveBoard([definition("Veraltet")], 1);
    const boardConflict = await staleBoard.json<{
      error: { code: string; currentSnapshot: { boardRevision: number; challenges: Challenge[] } };
    }>();
    expect(staleBoard.status).toBe(409);
    expect(boardConflict.error).toMatchObject({
      code: "revision_conflict",
      currentSnapshot: {
        boardRevision: firstBoardBody.snapshot.boardRevision,
        challenges: [{ title: "Erste" }],
      },
    });

    const settings = await fetchWorker("/api/challenges/settings", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        baseSettingsRevision: 1,
        styleId: "plain-list",
        themeMode: "own",
        surfaceOpacity: 0,
        headerStyle: "inverted",
        textEmphasis: "auto",
        fontFamily: "mono",
        fontScale: 1.5,
        headerTitle: "RUN",
        penaltyLabel: "STRAFE",
        penaltyText: "",
        effectsEnabled: false,
        maxVisible: 5,
        overflowMode: "page",
        overflowTempo: "fast",
        numbered: true,
        keyVisible: true,
        doneOrder: "keep",
        globalTimerMode: "down",
        globalTimerTotalMs: null,
        placement: { x: 300, y: 8, scale: 1 },
      }),
    });
    const settingsBody = await settings.json<{ snapshot: { settingsRevision: number } }>();
    expect(settings.status).toBe(200);

    const staleSettings = await fetchWorker("/api/challenges/settings", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        baseSettingsRevision: 1,
        styleId: "plain-list",
        themeMode: "own",
        surfaceOpacity: 100,
        headerStyle: "default",
        textEmphasis: "auto",
        fontFamily: "theme",
        fontScale: 1,
        headerTitle: "CHALLENGES",
        penaltyLabel: "STRAFE",
        penaltyText: "",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut", overflowTempo: "medium", numbered: false, keyVisible: false, doneOrder: "end", globalTimerMode: "down",
        globalTimerTotalMs: null,
        placement: { x: 300, y: 8, scale: 1 },
      }),
    });
    const settingsConflict = await staleSettings.json<{
      error: { code: string; currentSnapshot: { settingsRevision: number; settings: Record<string, unknown> } };
    }>();
    expect(staleSettings.status).toBe(409);
    expect(settingsConflict.error).toMatchObject({
      code: "revision_conflict",
      currentSnapshot: {
        settingsRevision: settingsBody.snapshot.settingsRevision,
        settings: { styleId: "plain-list", numbered: true, overflowMode: "page" },
      },
    });
  });

  it("weist beide falschen Kommandoformen und zu große Bodies zurück", async () => {
    const globalWithChallenge = await fetchWorker("/api/challenges/commands", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        commandId: commandId(),
        scope: "global",
        type: "startGlobalTimer",
        challengeId: "not-allowed",
      }),
    });
    const challengeWithoutId = await fetchWorker("/api/challenges/commands", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ commandId: commandId(), scope: "challenge", type: "complete" }),
    });
    const oversized = await fetchWorker("/api/challenges/commands", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: "x".repeat(32_769),
    });

    expect(globalWithChallenge.status).toBe(422);
    expect(challengeWithoutId.status).toBe(422);
    expect(oversized.status).toBe(413);
    expect((await globalWithChallenge.json<{ error: { code: string } }>()).error.code).toBe("validation_failed");
    expect((await challengeWithoutId.json<{ error: { code: string } }>()).error.code).toBe("validation_failed");
    expect((await oversized.json<{ error: { code: string } }>()).error.code).toBe("payload_too_large");
  });

  it("sichert Kommandos mit Origin und CSRF gegen Cross-Site-Requests ab", async () => {
    const command = {
      commandId: commandId(),
      scope: "global",
      type: "resetGlobalTimer",
    } as const;
    const missingCsrfHeaders = new Headers(authenticatedHeaders());
    missingCsrfHeaders.delete("x-csrf-token");
    const missingCsrf = await fetchWorker("/api/challenges/commands", {
      method: "POST",
      headers: missingCsrfHeaders,
      body: JSON.stringify(command),
    });
    const foreignOriginHeaders = new Headers(authenticatedHeaders());
    foreignOriginHeaders.set("origin", "https://evil.example");
    const foreignOrigin = await fetchWorker("/api/challenges/commands", {
      method: "POST",
      headers: foreignOriginHeaders,
      body: JSON.stringify({ ...command, commandId: commandId() }),
    });

    expect(missingCsrf.status).toBe(403);
    expect((await missingCsrf.json<{ error: { code: string } }>()).error.code).toBe("csrf_invalid");
    expect(foreignOrigin.status).toBe(403);
    expect((await foreignOrigin.json<{ error: { code: string } }>()).error.code).toBe("forbidden");
  });

  it("liefert den konkreten Domänengrund eines abgelehnten Kommandos", async () => {
    const board = await saveBoard([{ ...definition(), timerTotalMs: null }]);
    const boardBody = await board.json<{ snapshot: { challenges: Challenge[] } }>();
    const challenge = boardBody.snapshot.challenges[0];
    if (challenge === undefined) throw new Error("Challenge fehlt.");

    const challengeTimer = await fetchWorker("/api/challenges/commands", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        commandId: commandId(),
        scope: "challenge",
        type: "startTimer",
        challengeId: challenge.id,
      }),
    });
    const globalTimer = await fetchWorker("/api/challenges/commands", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        commandId: commandId(),
        scope: "global",
        type: "startGlobalTimer",
      }),
    });
    const challengeError = await challengeTimer.json<{ error: { code: string; message: string } }>();
    const globalError = await globalTimer.json<{ error: { code: string; message: string } }>();

    expect(challengeTimer.status).toBe(422);
    expect(challengeError.error).toEqual({
      code: "challenge_timer_not_configured",
      message: "Für diese Challenge ist kein Timer eingerichtet.",
    });
    expect(globalTimer.status).toBe(422);
    expect(globalError.error).toEqual({
      code: "global_timer_not_configured",
      message: "Für den globalen Timer ist keine Dauer eingerichtet.",
    });
  });

  it("antwortet auf allen vier Routen ohne Session mit unauthorized", async () => {
    const requests: Array<[string, RequestInit | undefined]> = [
      ["/api/challenges", { headers: { origin } }],
      ["/api/challenges/commands", { method: "POST", headers: { origin }, body: "{}" }],
      ["/api/challenges/board", {
        method: "PUT",
        headers: { origin, "x-editor-tab": tabId, "x-csrf-token": csrfToken },
        body: "{}",
      }],
      ["/api/challenges/settings", {
        method: "PUT",
        headers: { origin, "x-editor-tab": tabId, "x-csrf-token": csrfToken },
        body: "{}",
      }],
    ];

    for (const [path, init] of requests) {
      const response = await fetchWorker(path, init);
      expect(response.status, path).toBe(401);
      expect((await response.json<{ error: { code: string } }>()).error.code, path).toBe("unauthorized");
    }
  });

  it("klemmt increment an Grenzen und ändert erledigte Challenges nicht", async () => {
    const board = await saveBoard([definition()]);
    const body = await board.json<{ snapshot: { challenges: Challenge[] } }>();
    const challenge = body.snapshot.challenges[0];
    if (challenge === undefined) throw new Error("Challenge fehlt.");

    const sendIncrement = async (delta: number): Promise<Challenge> => {
      const response = await fetchWorker("/api/challenges/commands", {
        method: "POST",
        headers: authenticatedHeaders(),
        body: JSON.stringify({
          commandId: commandId(),
          scope: "challenge",
          type: "increment",
          challengeId: challenge.id,
          delta,
        }),
      });
      const result = await response.json<{ challenge: Challenge }>();
      return result.challenge;
    };

    expect((await sendIncrement(-99)).currentCount).toBe(0);
    expect((await sendIncrement(99)).state).toBe("done");
    const completed = await sendIncrement(-1);
    expect(completed.currentCount).toBe(3);
    expect(completed.state).toBe("done");
  });

  it("weist typfremde große Deltas als Validierungsfehler zurück und lässt sie für Messwerte zu", async () => {
    const board = await saveBoard([
      { ...definition("Counter"), targetCount: 999 },
      {
        ...definition("Messwert"),
        kind: "measure",
        unit: "m",
        targetCount: 1_500,
        sortOrder: 1,
        step: 50,
      },
    ]);
    const body = await board.json<{ snapshot: { challenges: Challenge[] } }>();
    const counter = body.snapshot.challenges.find(({ title }) => title === "Counter");
    const measure = body.snapshot.challenges.find(({ title }) => title === "Messwert");
    if (counter === undefined || measure === undefined) throw new Error("Test-Challenges fehlen.");

    const sendIncrement = async (challengeId: string, delta: number): Promise<Response> =>
      fetchWorker("/api/challenges/commands", {
        method: "POST",
        headers: authenticatedHeaders(),
        body: JSON.stringify({
          commandId: commandId(),
          scope: "challenge",
          type: "increment",
          challengeId,
          delta,
        }),
      });

    const rejected = await sendIncrement(counter.id, 100);
    expect(rejected.status).toBe(422);
    expect(await rejected.json<{ error: { code: string; message: string } }>()).toMatchObject({
      error: {
        code: "validation_failed",
        message: "Delta muss zwischen -99 und 99 liegen.",
      },
    });

    const counterAccepted = await sendIncrement(counter.id, 99);
    expect(counterAccepted.status).toBe(200);
    expect((await counterAccepted.json<{ challenge: Challenge }>()).challenge.currentCount).toBe(99);

    const measureAccepted = await sendIncrement(measure.id, 10_000);
    expect(measureAccepted.status).toBe(200);
    expect((await measureAccepted.json<{ challenge: Challenge }>()).challenge.currentCount).toBe(10_000);
  });

  it("setzt die Inkrement-Semantik von tick und streak vor der Domänenoperation durch", async () => {
    const board = await saveBoard([
      { ...definition("Tick"), kind: "tick", targetCount: null },
      { ...definition("Streak"), kind: "streak", targetCount: 5, sortOrder: 1 },
      { ...definition("Counter"), sortOrder: 2 },
    ]);
    const body = await board.json<{ snapshot: { challenges: Challenge[] } }>();
    const challenges = body.snapshot.challenges;
    const tick = challenges.find(({ title }) => title === "Tick");
    const streak = challenges.find(({ title }) => title === "Streak");
    const counter = challenges.find(({ title }) => title === "Counter");
    if (tick === undefined || streak === undefined || counter === undefined) {
      throw new Error("Test-Challenges fehlen.");
    }

    const sendIncrement = async (challengeId: string, delta: number): Promise<Response> =>
      fetchWorker("/api/challenges/commands", {
        method: "POST",
        headers: authenticatedHeaders(),
        body: JSON.stringify({
          commandId: commandId(),
          scope: "challenge",
          type: "increment",
          challengeId,
          delta,
        }),
      });

    const tickIncrement = await sendIncrement(tick.id, 1);
    expect(tickIncrement.status).toBe(422);
    expect(await tickIncrement.json<{ error: { code: string; message: string } }>()).toMatchObject({
      error: {
        code: "validation_failed",
        message: "Eine Challenge vom Typ tick darf nicht inkrementiert werden.",
      },
    });

    const tickComplete = await fetchWorker("/api/challenges/commands", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        commandId: commandId(),
        scope: "challenge",
        type: "complete",
        challengeId: tick.id,
      }),
    });
    expect(tickComplete.status).toBe(200);
    expect((await tickComplete.json<{ challenge: Challenge }>()).challenge.state).toBe("done");

    const streakNegative = await sendIncrement(streak.id, -1);
    expect(streakNegative.status).toBe(422);
    expect(await streakNegative.json<{ error: { code: string; message: string } }>()).toMatchObject({
      error: {
        code: "validation_failed",
        message: "Eine Challenge vom Typ streak akzeptiert keine negativen Deltas.",
      },
    });

    const streakPositive = await sendIncrement(streak.id, 1);
    expect(streakPositive.status).toBe(200);
    expect((await streakPositive.json<{ challenge: Challenge }>()).challenge.currentCount).toBe(1);

    const counterPositive = await sendIncrement(counter.id, 1);
    expect(counterPositive.status).toBe(200);
    const counterNegative = await sendIncrement(counter.id, -1);
    expect(counterNegative.status).toBe(200);
    expect((await counterNegative.json<{ challenge: Challenge }>()).challenge.currentCount).toBe(0);
  });

  it("setzt resetStreak auf null, lässt bestCount stehen und weist andere Typen mit 422 ab", async () => {
    const board = await saveBoard([
      { ...definition("Streak"), kind: "streak", targetCount: 5 },
      { ...definition("Counter"), sortOrder: 1 },
      { ...definition("Tick"), kind: "tick", targetCount: null, sortOrder: 2 },
      { ...definition("Measure"), kind: "measure", unit: "kg", targetCount: 1_500, sortOrder: 3 },
    ]);
    const body = await board.json<{ snapshot: { challenges: Challenge[] } }>();
    const challenges = body.snapshot.challenges;
    const streak = challenges.find(({ title }) => title === "Streak");
    if (streak === undefined) throw new Error("Streak fehlt.");

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE wc_challenges SET current_count = 4, best_count = 4 WHERE id = ?",
        streak.id,
      );
    });

    const resetRequest = {
      commandId: commandId(),
      scope: "challenge",
      type: "resetStreak",
      challengeId: streak.id,
    } as const;
    const reset = await fetchWorker("/api/challenges/commands", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify(resetRequest),
    });
    expect(reset.status).toBe(200);
    const resetBody = await reset.json<{ eventSeq: number; replayed: boolean; challenge: Challenge }>();
    expect(resetBody).toMatchObject({
      eventSeq: 1,
      replayed: false,
      challenge: { currentCount: 0, bestCount: 4 },
    });

    const replay = await fetchWorker("/api/challenges/commands", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify(resetRequest),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json<{ eventSeq: number; replayed: boolean; challenge: Challenge }>()).toMatchObject({
      eventSeq: 1,
      replayed: true,
      challenge: { currentCount: 0, bestCount: 4 },
    });

    for (const challenge of challenges.filter(({ title }) => title !== "Streak")) {
      const rejected = await fetchWorker("/api/challenges/commands", {
        method: "POST",
        headers: authenticatedHeaders(),
        body: JSON.stringify({
          commandId: commandId(),
          scope: "challenge",
          type: "resetStreak",
          challengeId: challenge.id,
        }),
      });
      expect(rejected.status, challenge.title).toBe(422);
      expect(await rejected.json<{ error: { code: string } }>()).toMatchObject({
        error: { code: "validation_failed" },
      });
    }
  });

  it("liefert eine reine GET-Nutzlast ohne event", async () => {
    const response = await fetchWorker("/api/challenges", { headers: { cookie, origin } });
    const body = await response.json<{ challenges: Challenge[] }>();
    expect(response.status).toBe(200);
    expectExactKeys(body, ["eventSeq", "boardRevision", "settingsRevision", "settings", "challenges"]);
    expect(body.challenges).toEqual([]);
  });

  it("führt HUD- und Challenge-Undo verschränkt über eine monotone Kanalsequenz", async () => {
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM state_history");
    });

    const initialHud = bootstrapResponseSchema.parse(
      await (await fetchWorker("/api/editor/bootstrap", { headers: { cookie, "x-editor-tab": tabId } })).json(),
    );
    csrfToken = initialHud.csrfToken;
    const { revision: initialRevision, overlayEnabled: _overlayEnabled, updatedAt: _updatedAt, updatedBy: _updatedBy, ...initialDraft } = initialHud.state;
    void [_overlayEnabled, _updatedAt, _updatedBy];
    const firstHud = await fetchWorker("/api/state", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        baseRevision: initialRevision,
        state: { ...initialDraft, player: { ...initialDraft.player, hpPercent: 99 } },
      }),
    });
    expect(firstHud.status).toBe(200);
    saveResponseSchema.parse(await firstHud.json());

    let challenge = await (await fetchWorker("/api/challenges", { headers: { cookie, origin } })).json<{
      eventSeq: number;
      boardRevision: number;
      settingsRevision: number;
      settings: Record<string, unknown>;
      challenges: Challenge[];
    }>();
    const firstBoard = await saveBoard([definition("Challenge 0")], challenge.boardRevision);
    expect(firstBoard.status).toBe(200);
    // `saveBoard` antwortet mit { snapshot, createdIds }; die Revisionen
    // stecken im Snapshot, nicht auf oberster Ebene.
    challenge = (await firstBoard.json<{ snapshot: typeof challenge }>()).snapshot;

    const secondHudBootstrap = bootstrapResponseSchema.parse(
      await (await fetchWorker("/api/editor/bootstrap", { headers: { cookie, "x-editor-tab": tabId } })).json(),
    );
    csrfToken = secondHudBootstrap.csrfToken;
    const { revision: secondRevision, overlayEnabled: _secondEnabled, updatedAt: _secondAt, updatedBy: _secondBy, ...secondDraft } = secondHudBootstrap.state;
    void [_secondEnabled, _secondAt, _secondBy];
    const secondHud = await fetchWorker("/api/state", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        baseRevision: secondRevision,
        state: { ...secondDraft, player: { ...secondDraft.player, hpPercent: 98 } },
      }),
    });
    expect(secondHud.status).toBe(200);
    saveResponseSchema.parse(await secondHud.json());

    for (let index = 1; index < 25; index += 1) {
      const response = await saveBoard([definition(`Challenge ${String(index)}`)], challenge.boardRevision);
      expect(response.status).toBe(200);
      challenge = (await response.json<{ snapshot: typeof challenge }>()).snapshot;
    }

    const rowsBeforeUndo = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{
        channel_seq: number;
        module_id: string;
        snapshot_json: string;
      }>("SELECT channel_seq, module_id, snapshot_json FROM state_history ORDER BY channel_seq").toArray(),
    );
    expect(rowsBeforeUndo.filter(({ module_id }) => module_id === "hud")).toHaveLength(2);
    expect(rowsBeforeUndo.filter(({ module_id }) => module_id === "challenges")).toHaveLength(20);
    expect(rowsBeforeUndo.map(({ channel_seq }) => channel_seq)).toEqual(
      rowsBeforeUndo.map(({ channel_seq }) => channel_seq).sort((left, right) => left - right),
    );
    const challengeTarget = rowsBeforeUndo.find(({ module_id }) => module_id === "challenges");
    if (challengeTarget === undefined) throw new Error("Challenge-Undo-Ziel fehlt.");

    const challengeUndo = await fetchWorker("/api/state/undo", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        moduleId: "challenges",
        channelSeq: challengeTarget.channel_seq,
        baseBoardRevision: challenge.boardRevision,
        baseSettingsRevision: challenge.settingsRevision,
        baseEventSeq: challenge.eventSeq,
      }),
    });
    expect(challengeUndo.status).toBe(200);
    const challengeUndoBody = await challengeUndo.json<{ snapshot: typeof challenge }>();
    expect(challengeUndoBody.snapshot.challenges[0]?.title).toBe("Challenge 4");

    const hudAfterChallengeUndo = bootstrapResponseSchema.parse(
      await (await fetchWorker("/api/editor/bootstrap", { headers: { cookie, "x-editor-tab": tabId } })).json(),
    );
    csrfToken = hudAfterChallengeUndo.csrfToken;
    expect(hudAfterChallengeUndo.state.player.hpPercent).toBe(98);

    const hudTargets = rowsBeforeUndo.filter(({ module_id }) => module_id === "hud");
    const hudTarget = hudTargets[0];
    if (hudTarget === undefined) throw new Error("HUD-Undo-Ziel fehlt.");
    const hudUndo = await fetchWorker("/api/state/undo", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        moduleId: "hud",
        channelSeq: hudTarget.channel_seq,
        baseRevision: hudAfterChallengeUndo.state.revision,
      }),
    });
    const hudUndoBody = saveResponseSchema.parse(await hudUndo.json());
    expect(hudUndo.status).toBe(200);
    expect(hudUndoBody.state.player.hpPercent).toBe(100);

    const challengeAfterHudUndo = await (await fetchWorker("/api/challenges", { headers: { cookie, origin } })).json<typeof challenge>();
    expect(challengeAfterHudUndo.challenges[0]?.title).toBe("Challenge 4");
    const rowsAfterUndo = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ channel_seq: number; module_id: string }>("SELECT channel_seq, module_id FROM state_history ORDER BY channel_seq").toArray(),
    );
    expect(rowsAfterUndo.filter(({ module_id }) => module_id === "challenges")).toHaveLength(20);
    expect(rowsAfterUndo.filter(({ module_id }) => module_id === "hud").length).toBeGreaterThanOrEqual(2);
    const previousMaxChannelSeq = Math.max(...rowsBeforeUndo.map(({ channel_seq }) => channel_seq));
    const channelSequencesAfterUndo = rowsAfterUndo.map(({ channel_seq }) => channel_seq);
    expect(channelSequencesAfterUndo).toContain(previousMaxChannelSeq + 1);
    expect(channelSequencesAfterUndo).toContain(previousMaxChannelSeq + 2);
    expect(Math.max(...channelSequencesAfterUndo)).toBe(previousMaxChannelSeq + 2);
  });

  it("verwaltet Server-Sets über die Session und liefert beim Laden den Payload", async () => {
    const board = await saveBoard([definition()]);
    expect(board.status).toBe(200);

    const saved = await fetchWorker("/api/challenges/sets", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ name: "API-Set", includeProgress: false }),
    });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json<{
      summary: { id: string; type: string; name: string; hasProgress: boolean };
      set: { name: string; challenges: unknown[] };
    }>();
    expect(savedBody.summary).toMatchObject({ type: "user", name: "API-Set", hasProgress: false });
    expect(savedBody.set).toMatchObject({ name: "API-Set" });

    const listed = await fetchWorker("/api/challenges/sets", { headers: authenticatedHeaders() });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json<{ sets: Array<Record<string, unknown>> }>();
    expect(listedBody.sets).toEqual([expect.objectContaining({ id: savedBody.summary.id, name: "API-Set" })]);
    expect(listedBody.sets[0]).not.toHaveProperty("payload");

    const loaded = await fetchWorker(`/api/challenges/sets/${encodeURIComponent(savedBody.summary.id)}`, {
      headers: authenticatedHeaders(),
    });
    expect(loaded.status).toBe(200);
    expect(await loaded.json<{ set: { name: string; challenges: unknown[] } }>()).toMatchObject({
      set: { name: "API-Set" },
    });

    const deleted = await fetchWorker(`/api/challenges/sets/${encodeURIComponent(savedBody.summary.id)}`, {
      method: "DELETE",
      headers: authenticatedHeaders(),
    });
    expect(deleted.status).toBe(200);
  });

  it("verweigert dem Dock-Token jede Set-Verwaltung", async () => {
    const dockHeaders = new Headers(authenticatedHeaders());
    dockHeaders.set("x-dock-token", "dock-token");
    const routes: Array<[string, string, string?]> = [
      ["GET", "/api/challenges/sets"],
      ["GET", "/api/challenges/sets/autosave"],
      ["POST", "/api/challenges/sets", JSON.stringify({ name: "Dock", includeProgress: false })],
      ["DELETE", "/api/challenges/sets/autosave"],
    ];
    for (const [method, path, body] of routes) {
      const response = await fetchWorker(path, { method, headers: dockHeaders, body: body ?? null });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json<{ error: { code: string } }>()).toMatchObject({ error: { code: "forbidden" } });
    }
  });
});
