import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/channel/migrations";
import { createSqlStorageChallengeRepository, type SqlStorageChallengeRepository } from "../../src/modules/win-challenges/adapters/sql-storage-challenge-repository";
import { IdempotencyMismatchError } from "../../src/modules/win-challenges/repository/challenge-repository";
import type { Challenge, ChallengeDefinition } from "../../src/modules/win-challenges/contracts/schemas";

const now = "2026-08-30T12:00:00.000Z";
const future = "2026-08-30T13:00:00.000Z";
const testChannelId = `win-challenges-step-2-${crypto.randomUUID()}`;
const stub = env.CHANNEL.get(env.CHANNEL.idFromName(testChannelId));

type GlobalTimerRow = {
  global_timer_total_ms: number | null;
  global_timer_ends_at: string | null;
  global_timer_paused_remain_ms: number | null;
};

const inRepository = <T>(callback: (repository: SqlStorageChallengeRepository) => T): Promise<T> =>
  runInDurableObject(stub, (_instance, state) =>
    callback(
      createSqlStorageChallengeRepository({
        sql: state.storage.sql,
        transactionSync: state.storage.transactionSync.bind(state.storage),
      }),
    ),
  );

const resetModuleTables = async (): Promise<void> => {
  await runInDurableObject(stub, (_instance, state) => {
    runMigrations(state.storage.sql, "worker-test");
    state.storage.sql.exec("DELETE FROM wc_challenges");
    state.storage.sql.exec("DELETE FROM wc_commands");
    state.storage.sql.exec("DELETE FROM wc_dock_tokens");
    state.storage.sql.exec(
      `UPDATE wc_meta SET
        event_seq = 0, board_revision = 1, settings_revision = 1,
        style_id = 'plain-list', theme_mode = 'inherit', surface_mode = 'surface',
        header_title = 'CHALLENGES', effects_enabled = 1, max_visible = 5,
        global_timer_total_ms = NULL, global_timer_ends_at = NULL,
        global_timer_paused_remain_ms = NULL
       WHERE singleton = 1`,
    );
  });
};

const readGlobalTimerRow = async (): Promise<GlobalTimerRow> =>
  runInDurableObject(stub, (_instance, state) => {
    const row = state.storage.sql
      .exec<GlobalTimerRow>(
        "SELECT global_timer_total_ms, global_timer_ends_at, global_timer_paused_remain_ms FROM wc_meta WHERE singleton = 1",
      )
      .toArray()[0];
    if (row === undefined) throw new Error("wc_meta ist nicht initialisiert.");
    return row;
  });

const definition = (title: string, sortOrder: number): ChallengeDefinition => ({
  clientId: `client-${String(sortOrder)}`,
  title,
  description: null,
  targetCount: 10,
  timerTotalMs: 60_000,
  sortOrder,
});

const definitionFor = (challenge: Challenge, title: string): ChallengeDefinition => ({
  id: challenge.id,
  title,
  description: challenge.description,
  targetCount: challenge.targetCount,
  timerTotalMs: challenge.timerTotalMs,
  sortOrder: challenge.sortOrder,
});

const onlyChallenge = (challenges: readonly Challenge[]): Challenge => {
  const challenge = challenges[0];
  if (challenge === undefined) throw new Error("Test erwartet eine Challenge.");
  return challenge;
};

describe("win-challenges repository and migration", () => {
  beforeAll(async () => {
    await runInDurableObject(stub, (_instance, state) => {
      runMigrations(state.storage.sql, "worker-test");
      runMigrations(state.storage.sql, "worker-test-second-run");
    });
  });

  beforeEach(resetModuleTables);

  it("runs MIGRATION_3 idempotently and seeds the complete meta row", async () => {
    const result = await runInDurableObject(stub, (_instance, state) => ({
      versions: state.storage.sql
        .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations ORDER BY version")
        .toArray()
        .map(({ version }) => version),
      tables: state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wc_%' ORDER BY name",
        )
        .toArray()
        .map(({ name }) => name),
      meta: state.storage.sql
        .exec<{
          event_seq: number;
          board_revision: number;
          settings_revision: number;
          style_id: string;
          theme_mode: string;
          surface_mode: string;
          header_title: string;
          effects_enabled: number;
          max_visible: number;
          global_timer_total_ms: number | null;
          global_timer_ends_at: string | null;
          global_timer_paused_remain_ms: number | null;
        }>("SELECT * FROM wc_meta WHERE singleton = 1")
        .toArray()[0],
      columns: state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(wc_meta)")
        .toArray()
        .map(({ name }) => name),
    }));

    expect(result.versions).toContain(3);
    expect(result.tables).toEqual([
      "wc_challenges",
      "wc_commands",
      "wc_dock_tokens",
      "wc_meta",
    ]);
    expect(result.columns).toEqual([
      "singleton",
      "event_seq",
      "board_revision",
      "settings_revision",
      "style_id",
      "theme_mode",
      "surface_mode",
      "header_title",
      "effects_enabled",
      "max_visible",
      "global_timer_total_ms",
      "global_timer_ends_at",
      "global_timer_paused_remain_ms",
    ]);
    expect(result.meta).toMatchObject({
      event_seq: 0,
      board_revision: 1,
      settings_revision: 1,
      style_id: "plain-list",
      theme_mode: "inherit",
      surface_mode: "surface",
      header_title: "CHALLENGES",
      effects_enabled: 1,
      max_visible: 5,
      global_timer_total_ms: null,
      global_timer_ends_at: null,
      global_timer_paused_remain_ms: null,
    });
  });

  it("enforces both global timer CHECK constraints", async () => {
    const result = await runInDurableObject(stub, (_instance, state) => {
      const errors: string[] = [];
      state.storage.sql.exec(
        "UPDATE wc_meta SET global_timer_total_ms = ?, global_timer_ends_at = ?, global_timer_paused_remain_ms = NULL WHERE singleton = 1",
        120_000,
        future,
      );
      try {
        state.storage.sql.exec(
          "UPDATE wc_meta SET global_timer_paused_remain_ms = ? WHERE singleton = 1",
          30_000,
        );
      } catch {
        errors.push("running-and-paused");
      }
      state.storage.sql.exec(
        "UPDATE wc_meta SET global_timer_total_ms = ?, global_timer_ends_at = NULL, global_timer_paused_remain_ms = NULL WHERE singleton = 1",
        120_000,
      );
      try {
        state.storage.sql.exec(
          "UPDATE wc_meta SET global_timer_total_ms = NULL, global_timer_ends_at = ? WHERE singleton = 1",
          future,
        );
      } catch {
        errors.push("runtime-without-definition");
      }
      return errors;
    });

    expect(result).toEqual(["running-and-paused", "runtime-without-definition"]);
  });

  it("merges board definitions without overwriting runtime fields", async () => {
    const created = await inRepository((repository) =>
      repository.saveBoard({ baseBoardRevision: 1, definitions: [definition("Original", 0)], now: now }),
    );
    const seeded = onlyChallenge(created.snapshot.challenges);
    const runtime = await inRepository((repository) =>
      repository.transaction((transaction) =>
        transaction.updateChallengeRuntime(
          seeded.id,
          {
            currentCount: 4,
            state: "active",
            timerEndsAt: future,
            completedAt: null,
          },
          now,
        ),
      ),
    );
    if (runtime === null) throw new Error("Runtime-Challenge konnte nicht gesetzt werden.");

    const saved = await inRepository((repository) =>
      repository.saveBoard({
        baseBoardRevision: created.snapshot.boardRevision,
        definitions: [
          definitionFor(
            runtime,
            "Geänderter Titel",
          ),
        ],
        now: future,
      }),
    );
    const result = onlyChallenge(saved.snapshot.challenges);

    expect(result).toMatchObject({
      id: seeded.id,
      title: "Geänderter Titel",
      currentCount: 4,
      state: "active",
      timerEndsAt: future,
      completedAt: null,
    });
  });

  it("changes settings without deleting a running global timer", async () => {
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE wc_meta SET global_timer_total_ms = ?, global_timer_ends_at = ?, global_timer_paused_remain_ms = NULL WHERE singleton = 1",
        120_000,
        future,
      );
    });
    const before = await inRepository((repository) => repository.readSnapshot());
    const saved = await inRepository((repository) =>
      repository.saveSettings({
        baseSettingsRevision: before.settingsRevision,
        styleId: "plain-numbered",
        themeMode: "own",
        surfaceMode: "bare",
        headerTitle: "RUN",
        effectsEnabled: false,
        maxVisible: 6,
        globalTimerTotalMs: 180_000,
        now: future,
      }),
    );

    expect(saved.snapshot.settings).toMatchObject({
      styleId: "plain-numbered",
      themeMode: "own",
      surfaceMode: "bare",
      headerTitle: "RUN",
      effectsEnabled: false,
      maxVisible: 6,
      globalTimer: { totalMs: 180_000, endsAt: future, pausedRemainMs: null },
    });
  });

  it("stops a running global timer when settings disable it", async () => {
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE wc_meta SET global_timer_total_ms = ?, global_timer_ends_at = ?, global_timer_paused_remain_ms = NULL WHERE singleton = 1",
        120_000,
        future,
      );
    });
    const before = await inRepository((repository) => repository.readSnapshot());
    const saved = await inRepository((repository) =>
      repository.saveSettings({
        baseSettingsRevision: before.settingsRevision,
        styleId: "plain-list",
        themeMode: "inherit",
        surfaceMode: "surface",
        headerTitle: "CHALLENGES",
        effectsEnabled: true,
        maxVisible: 5,
        globalTimerTotalMs: null,
        now: future,
      }),
    );

    expect(saved.snapshot.settings.globalTimer).toBeNull();
    expect(await readGlobalTimerRow()).toEqual({
      global_timer_total_ms: null,
      global_timer_ends_at: null,
      global_timer_paused_remain_ms: null,
    });
  });

  it("stops a paused global timer when settings disable it", async () => {
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE wc_meta SET global_timer_total_ms = ?, global_timer_ends_at = NULL, global_timer_paused_remain_ms = ? WHERE singleton = 1",
        120_000,
        30_000,
      );
    });
    const before = await inRepository((repository) => repository.readSnapshot());
    const saved = await inRepository((repository) =>
      repository.saveSettings({
        baseSettingsRevision: before.settingsRevision,
        styleId: "plain-list",
        themeMode: "inherit",
        surfaceMode: "surface",
        headerTitle: "CHALLENGES",
        effectsEnabled: true,
        maxVisible: 5,
        globalTimerTotalMs: null,
        now: now,
      }),
    );

    expect(saved.snapshot.settings.globalTimer).toBeNull();
    expect(await readGlobalTimerRow()).toEqual({
      global_timer_total_ms: null,
      global_timer_ends_at: null,
      global_timer_paused_remain_ms: null,
    });
  });

  it("sums two consecutive atomic increments", async () => {
    const created = await inRepository((repository) =>
      repository.saveBoard({ baseBoardRevision: 1, definitions: [definition("Counter", 0)], now: now }),
    );
    const challenge = onlyChallenge(created.snapshot.challenges);
    const counts = await inRepository((repository) =>
      repository.transaction((transaction) => {
        const first = transaction.incrementChallengeCount(challenge.id, 1, 10, now);
        const second = transaction.incrementChallengeCount(challenge.id, 1, 10, now);
        return [first?.currentCount ?? null, second?.currentCount ?? null];
      }),
    );

    expect(counts).toEqual([1, 2]);
    expect((await inRepository((repository) => repository.readChallenge(challenge.id)))?.currentCount).toBe(2);
  });

  it("deduplicates a command by hash and rejects a hash mismatch", async () => {
    const created = await inRepository((repository) =>
      repository.saveBoard({ baseBoardRevision: 1, definitions: [definition("Dedupe", 0)], now: now }),
    );
    const challenge = onlyChallenge(created.snapshot.challenges);
    const commandId = "11111111-1111-4111-8111-111111111111";
    const execute = (repository: SqlStorageChallengeRepository, hash: string) =>
      repository.runCommand(
        { commandId, requestHash: hash, createdAt: now },
        (transaction) => {
          const current = transaction.readChallenge(challenge.id);
          if (current === null) throw new Error("Challenge fehlt.");
          const updated = transaction.incrementChallengeCount(
            challenge.id,
            1,
            current.targetCount ?? 999,
            now,
          );
          if (updated === null) throw new Error("Challenge konnte nicht aktualisiert werden.");
          return {
            value: updated,
            event: {
              scope: "challenge" as const,
              type: "progressed" as const,
              challengeId: challenge.id,
              delta: 1,
              previousCount: current.currentCount,
              currentCount: updated.currentCount,
            },
          };
        },
        (transaction) => {
          const current = transaction.readChallenge(challenge.id);
          if (current === null) throw new Error("Challenge fehlt.");
          return current;
        },
      );

    const first = await inRepository((repository) => execute(repository, "hash-a"));
    const replay = await inRepository((repository) =>
      repository.runCommand(
        { commandId, requestHash: "hash-a", createdAt: now },
        () => {
          throw new Error("Replay darf die Mutation nicht ausführen.");
        },
        (transaction) => {
          const current = transaction.readChallenge(challenge.id);
          if (current === null) throw new Error("Challenge fehlt.");
          return current;
        },
      ),
    );

    expect(first).toMatchObject({ eventSeq: 1, replayed: false, value: { currentCount: 1 } });
    expect(replay).toMatchObject({ eventSeq: 1, replayed: true, value: { currentCount: 1 } });
    await expect(
      inRepository((repository) => execute(repository, "hash-b")),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
    expect((await inRepository((repository) => repository.readChallenge(challenge.id)))?.currentCount).toBe(1);
  });

  it("prunes only commands older than 24 hours", async () => {
    const oldCreatedAt = new Date(Date.parse(now) - 25 * 60 * 60 * 1_000).toISOString();
    const recentCreatedAt = new Date(Date.parse(now) - 23 * 60 * 60 * 1_000).toISOString();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO wc_commands(command_id, request_hash, created_at) VALUES (?, ?, ?)",
        "22222222-2222-4222-8222-222222222222",
        "old",
        oldCreatedAt,
      );
      state.storage.sql.exec(
        "INSERT INTO wc_commands(command_id, request_hash, created_at) VALUES (?, ?, ?)",
        "33333333-3333-4333-8333-333333333333",
        "recent",
        recentCreatedAt,
      );
    });
    await inRepository((repository) => {
      repository.pruneCommands(now);
    });
    const remaining = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ command_id: string; request_hash: string }>(
          "SELECT command_id, request_hash FROM wc_commands ORDER BY command_id",
        )
        .toArray(),
    );

    expect(remaining).toEqual([
      {
        command_id: "33333333-3333-4333-8333-333333333333",
        request_hash: "recent",
      },
    ]);
  });

  it("measures rowsWritten and rowsRead for the four repository operations", async () => {
    const definitions = [definition("One", 0), definition("Two", 1), definition("Three", 2)];
    const board = await inRepository((repository) =>
      repository.measure(() =>
        repository.saveBoard({ baseBoardRevision: 1, definitions, now: now }),
      ),
    );
    const challenge = onlyChallenge(board.result.snapshot.challenges);
    const mutation = await inRepository((repository) =>
      repository.measure(() =>
        repository.runCommand(
          {
            commandId: "44444444-4444-4444-8444-444444444444",
            requestHash: "mutation",
            createdAt: now,
          },
          (transaction) => {
            const current = transaction.readChallenge(challenge.id);
            if (current === null) throw new Error("Challenge fehlt.");
            const updated = transaction.incrementChallengeCount(
              challenge.id,
              1,
              current.targetCount ?? 999,
              now,
            );
            if (updated === null) throw new Error("Challenge konnte nicht aktualisiert werden.");
            return {
              value: updated,
              event: {
                scope: "challenge" as const,
                type: "progressed" as const,
                challengeId: challenge.id,
                delta: 1,
                previousCount: current.currentCount,
                currentCount: updated.currentCount,
              },
            };
          },
          (transaction) => {
            const current = transaction.readChallenge(challenge.id);
            if (current === null) throw new Error("Challenge fehlt.");
            return current;
          },
        ),
      ),
    );
    const settings = await inRepository((repository) =>
      repository.measure(() =>
        repository.saveSettings({
          baseSettingsRevision: board.result.snapshot.settingsRevision,
          styleId: "plain-list",
          themeMode: "inherit",
          surfaceMode: "surface",
          headerTitle: "CHALLENGES",
          effectsEnabled: true,
          maxVisible: 5,
          globalTimerTotalMs: null,
          now: now,
        }),
      ),
    );
    const snapshot = await inRepository((repository) =>
      repository.measure(() => repository.readSnapshot()),
    );

    console.info("win-challenges rows metrics", {
      mutation: { rowsWritten: mutation.rowsWritten, rowsRead: mutation.rowsRead },
      boardSave: { rowsWritten: board.rowsWritten, rowsRead: board.rowsRead },
      settingsSave: { rowsWritten: settings.rowsWritten, rowsRead: settings.rowsRead },
      snapshotRead: { rowsWritten: snapshot.rowsWritten, rowsRead: snapshot.rowsRead },
    });
    expect(mutation).toMatchObject({ rowsWritten: 4, rowsRead: 5 });
    expect(board).toMatchObject({ rowsWritten: 7, rowsRead: 15 });
    expect(settings).toMatchObject({ rowsWritten: 1, rowsRead: 15 });
    expect(snapshot).toMatchObject({ rowsWritten: 0, rowsRead: 7 });
  });
});
