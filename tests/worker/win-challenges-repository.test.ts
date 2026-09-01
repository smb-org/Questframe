import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/channel/migrations";
import { createSqlStorageChallengeRepository, type SqlStorageChallengeRepository } from "../../src/modules/win-challenges/adapters/sql-storage-challenge-repository";
import { MAX_COUNT } from "../../src/modules/win-challenges/contracts/predicates";
import { createWinChallenges, hashChallengeCommand } from "../../src/modules/win-challenges/service/commands";
import { IdempotencyMismatchError } from "../../src/modules/win-challenges/repository/challenge-repository";
import type { Challenge, ChallengeDefinition } from "../../src/modules/win-challenges/contracts/schemas";

const now = "2026-08-30T12:00:00.000Z";
const future = "2026-08-30T13:00:00.000Z";
const testChannelId = `win-challenges-step-2-${crypto.randomUUID()}`;
const stub = env.CHANNEL.get(env.CHANNEL.idFromName(testChannelId));
const legacyStub = env.CHANNEL.get(env.CHANNEL.idFromName(`win-challenges-legacy-${crypto.randomUUID()}`));

type GlobalTimerRow = {
  global_timer_total_ms: number | null;
  global_timer_mode: string;
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
        overflow_mode = 'cut', overflow_tempo = 'medium', numbered = 0, done_order = 'end',
        placement_x = 300, placement_y = 8, placement_scale = 1,
        global_timer_mode = 'down',
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
        "SELECT global_timer_total_ms, global_timer_mode, global_timer_ends_at, global_timer_paused_remain_ms FROM wc_meta WHERE singleton = 1",
      )
      .toArray()[0];
    if (row === undefined) throw new Error("wc_meta ist nicht initialisiert.");
    return row;
  });

const definition = (title: string, sortOrder: number): ChallengeDefinition => ({
  clientId: `client-${String(sortOrder)}`,
  title,
  targetCount: 10,
  timerTotalMs: 60_000,
  sortOrder,
  hidden: false,
});

const definitionFor = (challenge: Challenge, title: string): ChallengeDefinition => ({
  id: challenge.id,
  title,
  targetCount: challenge.targetCount,
  timerTotalMs: challenge.timerTotalMs,
  sortOrder: challenge.sortOrder,
  hidden: challenge.hidden,
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

  it("runs the win-challenges migrations idempotently and seeds the complete rows", async () => {
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
          overflow_mode: string;
          overflow_tempo: string;
          numbered: number;
          done_order: string;
          placement_x: number;
          placement_y: number;
          placement_scale: number;
          global_timer_mode: string;
          global_timer_total_ms: number | null;
          global_timer_ends_at: string | null;
          global_timer_paused_remain_ms: number | null;
        }>("SELECT * FROM wc_meta WHERE singleton = 1")
        .toArray()[0],
      columns: state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(wc_meta)")
        .toArray()
        .map(({ name }) => name),
      challengeColumns: state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(wc_challenges)")
        .toArray()
        .map(({ name }) => name),
    }));

    expect(result.versions).toContain(3);
    expect(result.versions).toContain(4);
    expect(result.versions).toContain(5);
    expect(result.versions).toContain(6);
    expect(result.versions).toContain(7);
    expect(result.versions).toContain(8);
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
      "overflow_mode",
      "overflow_tempo",
      "numbered",
      "done_order",
      "global_timer_mode",
      "placement_x",
      "placement_y",
      "placement_scale",
      "global_timer_total_ms",
      "global_timer_ends_at",
      "global_timer_paused_remain_ms",
    ]);
    expect(result.challengeColumns).toEqual([
      "id",
      "title",
      "target_count",
      "timer_total_ms",
      "sort_order",
      "current_count",
      "state",
      "timer_ends_at",
      "completed_at",
      "created_at",
      "updated_at",
      "hidden",
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
      overflow_mode: "cut",
      overflow_tempo: "medium",
      numbered: 0,
      done_order: "end",
      placement_x: 300,
      placement_y: 8,
      placement_scale: 1,
      global_timer_mode: "down",
      global_timer_total_ms: null,
      global_timer_ends_at: null,
      global_timer_paused_remain_ms: null,
    });
  });

  it("überführt alte Meta-Zeilen mit plain-numbered und max_visible vollständig", async () => {
    const placement = await runInDurableObject(legacyStub, (_instance, state) => {
      state.storage.sql.exec(`
        DROP TABLE wc_meta;
        DROP TABLE _sql_schema_migrations;
        CREATE TABLE _sql_schema_migrations (
          version INTEGER PRIMARY KEY,
          build_id TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE wc_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          event_seq INTEGER NOT NULL,
          board_revision INTEGER NOT NULL,
          settings_revision INTEGER NOT NULL,
          style_id TEXT NOT NULL,
          theme_mode TEXT NOT NULL,
          surface_mode TEXT NOT NULL,
          header_title TEXT NOT NULL,
          effects_enabled INTEGER NOT NULL,
          max_visible INTEGER NOT NULL,
          global_timer_total_ms INTEGER,
          global_timer_ends_at TEXT,
          global_timer_paused_remain_ms INTEGER
        );
        INSERT INTO _sql_schema_migrations(version, build_id, applied_at)
        VALUES
          (1, 'legacy', '2026-08-30T12:00:00.000Z'),
          (2, 'legacy', '2026-08-30T12:00:00.000Z'),
          (3, 'legacy', '2026-08-30T12:00:00.000Z'),
          (4, 'legacy', '2026-08-30T12:00:00.000Z');
        INSERT INTO wc_meta(
          singleton, event_seq, board_revision, settings_revision, style_id,
          theme_mode, surface_mode, header_title, effects_enabled, max_visible,
          global_timer_total_ms, global_timer_ends_at, global_timer_paused_remain_ms
        ) VALUES (1, 0, 1, 1, 'plain-numbered', 'inherit', 'surface', 'CHALLENGES', 1, 5, NULL, NULL, NULL);
      `);
      runMigrations(state.storage.sql, "worker-test-legacy");
      return {
        placement: state.storage.sql.exec<{
          style_id: string;
          numbered: number;
          placement_x: number;
          placement_y: number;
          placement_scale: number;
          global_timer_mode: string;
        }>("SELECT style_id, numbered, placement_x, placement_y, placement_scale, global_timer_mode FROM wc_meta WHERE singleton = 1").toArray()[0],
        versions: state.storage.sql.exec<{ version: number }>("SELECT version FROM _sql_schema_migrations ORDER BY version").toArray().map(({ version }) => version),
      };
    });

    expect(placement.placement).toEqual({ style_id: "plain-list", numbered: 1, placement_x: 300, placement_y: 8, placement_scale: 1, global_timer_mode: "down" });
    expect(placement.versions).toContain(8);
    const columns = await runInDurableObject(legacyStub, (_instance, state) => state.storage.sql.exec<{ name: string }>("PRAGMA table_info(wc_meta)").toArray().map(({ name }) => name));
    expect(columns).toContain("max_visible");
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

  it("enforces the hidden Boolean CHECK constraint", async () => {
    await inRepository((repository) =>
      repository.saveBoard({ baseBoardRevision: 1, definitions: [definition("Hidden", 0)], now }),
    );
    const rejected = await runInDurableObject(stub, (_instance, state) => {
      try {
        state.storage.sql.exec("UPDATE wc_challenges SET hidden = 2");
      } catch {
        return true;
      }
      return false;
    });

    expect(rejected).toBe(true);
  });

  it("normalisiert beim Nachholen von Migration 4 Alt-Timer erledigter Challenges", async () => {
    const created = await inRepository((repository) =>
      repository.saveBoard({ baseBoardRevision: 1, definitions: [definition("Alt erledigt", 0)], now }),
    );
    const seeded = onlyChallenge(created.snapshot.challenges);
    const timer = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE wc_challenges SET state = 'done', timer_ends_at = ? WHERE id = ?",
        future,
        seeded.id,
      );
      state.storage.sql.exec("DELETE FROM _sql_schema_migrations WHERE version = 4");
      runMigrations(state.storage.sql, "worker-test-migration-4");
      return state.storage.sql
        .exec<{ timer_ends_at: string | null }>(
          "SELECT timer_ends_at FROM wc_challenges WHERE id = ?",
          seeded.id,
        )
        .toArray()[0]?.timer_ends_at;
    });

    expect(timer).toBeNull();
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
            hidden: false,
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

  it("resets a running global timer when its configured duration changes", async () => {
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
        themeMode: "own",
        surfaceMode: "bare",
        headerTitle: "RUN",
        effectsEnabled: false,
        maxVisible: 8,
        overflowMode: "page",
        overflowTempo: "fast",
        numbered: true,
        doneOrder: "keep",
        globalTimerMode: "up",
        globalTimerTotalMs: 180_000,
        placement: { x: 12, y: 34, scale: 1.25 },
        now: future,
      }),
    );

    expect(saved.snapshot.settings).toMatchObject({
      styleId: "plain-list",
      themeMode: "own",
      surfaceMode: "bare",
      headerTitle: "RUN",
      effectsEnabled: false,
      overflowMode: "page",
      overflowTempo: "fast",
      numbered: true,
      doneOrder: "keep",
      placement: { x: 12, y: 34, scale: 1.25 },
      globalTimer: { totalMs: 180_000, endsAt: null, pausedRemainMs: null },
      globalTimerMode: "up",
    });
    expect((await readGlobalTimerRow()).global_timer_mode).toBe("up");
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
        overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end",
        globalTimerMode: "down",
        globalTimerTotalMs: null,
        placement: { x: 300, y: 8, scale: 1 },
        now: future,
      }),
    );

    expect(saved.snapshot.settings.globalTimer).toBeNull();
    expect(await readGlobalTimerRow()).toEqual({
      global_timer_total_ms: null,
      global_timer_mode: "down",
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
        overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end",
        globalTimerMode: "down",
        globalTimerTotalMs: null,
        placement: { x: 300, y: 8, scale: 1 },
        now: now,
      }),
    );

    expect(saved.snapshot.settings.globalTimer).toBeNull();
    expect(await readGlobalTimerRow()).toEqual({
      global_timer_total_ms: null,
      global_timer_mode: "down",
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
            current.targetCount ?? MAX_COUNT,
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

  it("hält die Schreibbaseline für ein vollendendes increment ein", async () => {
    const created = await inRepository((repository) =>
      repository.saveBoard({
        baseBoardRevision: 1,
        definitions: [{ ...definition("Complete", 0), targetCount: 1, hidden: true }],
        now,
      }),
    );
    const challenge = onlyChallenge(created.snapshot.challenges);
    const command = {
      commandId: "55555555-5555-4555-8555-555555555555",
      scope: "challenge",
      type: "increment",
      challengeId: challenge.id,
      delta: 1,
    } as const;
    const requestHash = await hashChallengeCommand(command);
    const measured = await inRepository((repository) =>
      repository.measure(() =>
        createWinChallenges({ repository, clock: () => now }).executeCommandWithHash(
          command,
          requestHash,
        ),
      ),
    );

    expect(measured.rowsWritten).toBe(4);
    expect(measured.result).toMatchObject({
      response: {
        replayed: false,
        challenge: { currentCount: 1, state: "done" },
      },
      update: {
        event: { type: "completed" },
        challenges: [{ currentCount: 1, state: "done" }],
      },
    });
    expect(measured.result.response.challenge?.hidden).toBe(false);
    expect(measured.result.response.challenge?.timerEndsAt).toBeNull();
  });

  it("misst alle drei globalen Timer-Kommandos mit einem Meta-Update", async () => {
    const created = await inRepository((repository) =>
      repository.saveBoard({
        baseBoardRevision: 1,
        definitions: [definition("One", 0), definition("Two", 1), definition("Three", 2)],
        now,
      }),
    );
    await inRepository((repository) =>
      repository.saveSettings({
        baseSettingsRevision: created.snapshot.settingsRevision,
        styleId: "plain-list",
        themeMode: "inherit",
        surfaceMode: "surface",
        headerTitle: "CHALLENGES",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end",
        globalTimerMode: "down",
        globalTimerTotalMs: 120_000,
        placement: { x: 300, y: 8, scale: 1 },
        now,
      }),
    );

    const commands = [
      {
        commandId: "66666666-6666-4666-8666-666666666666",
        scope: "global",
        type: "startGlobalTimer",
      },
      {
        commandId: "77777777-7777-4777-8777-777777777777",
        scope: "global",
        type: "pauseGlobalTimer",
      },
      {
        commandId: "88888888-8888-4888-8888-888888888888",
        scope: "global",
        type: "resetGlobalTimer",
      },
    ] as const;
    const measured = [];
    for (const command of commands) {
      const requestHash = await hashChallengeCommand(command);
      measured.push(
        await inRepository((repository) =>
          repository.measure(() =>
            createWinChallenges({ repository, clock: () => now }).executeCommandWithHash(
              command,
              requestHash,
            ),
          ),
        ),
      );
    }

    expect(measured.map(({ rowsWritten, rowsRead }) => ({ rowsWritten, rowsRead }))).toEqual([
      { rowsWritten: 3, rowsRead: 17 },
      { rowsWritten: 3, rowsRead: 18 },
      { rowsWritten: 3, rowsRead: 19 },
    ]);
    expect(measured.map(({ result }) => result.response.eventSeq)).toEqual([1, 2, 3]);
    expect(measured.map(({ result }) => result.update.event?.type)).toEqual([
      "global_started",
      "global_paused",
      "global_reset",
    ]);
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
              current.targetCount ?? MAX_COUNT,
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
          overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end",
          globalTimerMode: "down",
          globalTimerTotalMs: null,
          placement: { x: 300, y: 8, scale: 1 },
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
    expect(settings).toMatchObject({ rowsWritten: 1, rowsRead: 17 });
    expect(snapshot).toMatchObject({ rowsWritten: 0, rowsRead: 7 });
  });
});
