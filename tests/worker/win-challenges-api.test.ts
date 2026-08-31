import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/channel/migrations";
import { createSqlStorageChallengeRepository } from "../../src/modules/win-challenges/adapters/sql-storage-challenge-repository";
import type { Challenge, ChallengeDefinition } from "../../src/modules/win-challenges/contracts/schemas";
import { createWinChallenges, hashChallengeCommand } from "../../src/modules/win-challenges/service/commands";

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
  description: null,
  targetCount: 3,
  timerTotalMs: 10_000,
  sortOrder: 0,
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
    state.storage.sql.exec(
      `UPDATE wc_meta SET
        event_seq = 0, board_revision = 1, settings_revision = 1,
        style_id = 'plain-list', theme_mode = 'inherit', surface_mode = 'surface',
        header_title = 'CHALLENGES', effects_enabled = 1, max_visible = 5,
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

  it("führt alle acht Mutationen über den Service mit dem HTTP-Vertrag aus", async () => {
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

    const settingsResponse = await fetchWorker("/api/challenges/settings", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        baseSettingsRevision: 1,
        styleId: "plain-list",
        themeMode: "inherit",
        surfaceMode: "surface",
        headerTitle: "CHALLENGES",
        effectsEnabled: true,
        maxVisible: 5,
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
    expect(resetGlobalTimer.eventSeq).toBe(8);
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
        styleId: "plain-numbered",
        themeMode: "own",
        surfaceMode: "bare",
        headerTitle: "RUN",
        effectsEnabled: false,
        maxVisible: 6,
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
        themeMode: "inherit",
        surfaceMode: "surface",
        headerTitle: "CHALLENGES",
        effectsEnabled: true,
        maxVisible: 5,
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
        settings: { styleId: "plain-numbered" },
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

  it("liefert eine reine GET-Nutzlast ohne event", async () => {
    const response = await fetchWorker("/api/challenges", { headers: { cookie, origin } });
    const body = await response.json<{ challenges: Challenge[] }>();
    expect(response.status).toBe(200);
    expectExactKeys(body, ["eventSeq", "boardRevision", "settingsRevision", "settings", "challenges"]);
    expect(body.challenges).toEqual([]);
  });
});
