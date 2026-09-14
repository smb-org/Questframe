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
const migrationNineStub = env.CHANNEL.get(env.CHANNEL.idFromName(`win-challenges-migration-nine-${crypto.randomUUID()}`));
const migrationElevenStub = env.CHANNEL.get(env.CHANNEL.idFromName(`win-challenges-migration-eleven-${crypto.randomUUID()}`));
const migrationFifteenStub = env.CHANNEL.get(env.CHANNEL.idFromName(`win-challenges-migration-fifteen-${crypto.randomUUID()}`));

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
    state.storage.sql.exec("DELETE FROM wc_retired_keys");
    state.storage.sql.exec("DELETE FROM wc_commands");
    state.storage.sql.exec("DELETE FROM wc_dock_tokens");
    state.storage.sql.exec(
      `UPDATE wc_meta SET
        event_seq = 0, board_revision = 1, settings_revision = 1,
        style_id = 'plain-list', theme_mode = 'inherit', surface_opacity = 100,
        font_family = 'theme', font_scale = 1,
        header_title = 'CHALLENGES', penalty_label = 'STRAFE', penalty_text = '', effects_enabled = 1, max_visible = 5,
        overflow_mode = 'cut', overflow_tempo = 'medium', numbered = 0, key_visible = 0, done_order = 'end',
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
  kind: "counter",
  unit: null,
  targetCount: 10,
  timerTotalMs: 60_000,
  sortOrder,
  step: 1,
  hidden: false,
});

const definitionFor = (challenge: Challenge, title: string): ChallengeDefinition => ({
  id: challenge.id,
  title,
  kind: challenge.kind,
  unit: challenge.unit,
  targetCount: challenge.targetCount,
  timerTotalMs: challenge.timerTotalMs,
  sortOrder: challenge.sortOrder,
  step: challenge.step,
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
          surface_opacity: number;
          header_style: string;
          text_emphasis: string;
          font_family: string;
          font_scale: number;
          header_title: string;
          penalty_label: string;
          penalty_text: string;
          effects_enabled: number;
          max_visible: number;
          overflow_mode: string;
          overflow_tempo: string;
          numbered: number;
          key_visible: number;
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
    expect(result.versions).toContain(9);
    expect(result.versions).toContain(10);
    expect(result.versions).toContain(11);
    expect(result.versions).toContain(12);
    expect(result.versions).toContain(13);
    expect(result.versions).toContain(14);
    expect(result.versions).toContain(15);
    expect(result.versions).toContain(16);
    expect(result.versions).toContain(17);
    expect(result.tables).toEqual([
      "wc_challenges",
      "wc_commands",
      "wc_dock_tokens",
      "wc_meta",
      "wc_retired_keys",
    ]);
    expect(result.columns).toEqual([
      "singleton",
      "event_seq",
      "board_revision",
      "settings_revision",
      "style_id",
      "theme_mode",
      "surface_opacity",
      "header_style",
      "text_emphasis",
      "font_family",
      "font_scale",
      "header_title",
      "penalty_label",
      "penalty_text",
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
      "key_visible",
    ]);
    expect(result.challengeColumns).toEqual([
      "id",
      "title",
      "kind",
      "unit",
      "control_key",
      "target_count",
      "timer_total_ms",
      "sort_order",
      "step",
      "best_count",
      "hidden",
      "current_count",
      "state",
      "timer_ends_at",
      "timer_remain_ms",
      "completed_at",
      "created_at",
      "updated_at",
    ]);
    expect(result.meta).toMatchObject({
      event_seq: 0,
      board_revision: 1,
      settings_revision: 1,
      style_id: "plain-list",
      theme_mode: "inherit",
      surface_opacity: 100,
      header_style: "default",
      text_emphasis: "auto",
      font_family: "theme",
      font_scale: 1,
      header_title: "CHALLENGES",
      penalty_label: "STRAFE",
      penalty_text: "",
      effects_enabled: 1,
      max_visible: 5,
      overflow_mode: "cut",
      overflow_tempo: "medium",
      numbered: 0,
      key_visible: 0,
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

  it("fügt einer alten Datenbank Strafen-Label und Schrifteffekt mit Vorgabewert hinzu", async () => {
    const result = await runInDurableObject(migrationFifteenStub, (_instance, state) => {
      runMigrations(state.storage.sql, "worker-test-before-penalty-label");
      state.storage.sql.exec("ALTER TABLE wc_meta DROP COLUMN penalty_label");
      state.storage.sql.exec("ALTER TABLE wc_meta DROP COLUMN text_emphasis");
      state.storage.sql.exec("DELETE FROM _sql_schema_migrations WHERE version = 15");
      state.storage.sql.exec("DELETE FROM _sql_schema_migrations WHERE version = 16");
      runMigrations(state.storage.sql, "worker-test-penalty-label");
      return {
        label: state.storage.sql
          .exec<{ penalty_label: string }>("SELECT penalty_label FROM wc_meta WHERE singleton = 1")
          .toArray()[0]?.penalty_label,
        textEmphasis: state.storage.sql
          .exec<{ text_emphasis: string }>("SELECT text_emphasis FROM wc_meta WHERE singleton = 1")
          .toArray()[0]?.text_emphasis,
        versions: state.storage.sql
          .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations ORDER BY version")
          .toArray()
          .map(({ version }) => version),
      };
    });

    expect(result.label).toBe("STRAFE");
    expect(result.textEmphasis).toBe("auto");
    expect(result.versions).toContain(15);
    expect(result.versions).toContain(16);
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
        headerStyle: state.storage.sql.exec<{ header_style: string }>("SELECT header_style FROM wc_meta WHERE singleton = 1").toArray()[0]?.header_style,
        textEmphasis: state.storage.sql.exec<{ text_emphasis: string }>("SELECT text_emphasis FROM wc_meta WHERE singleton = 1").toArray()[0]?.text_emphasis,
        fontSettings: state.storage.sql.exec<{ font_family: string; font_scale: number }>("SELECT font_family, font_scale FROM wc_meta WHERE singleton = 1").toArray()[0],
        surfaceOpacity: state.storage.sql.exec<{ surface_opacity: number }>("SELECT surface_opacity FROM wc_meta WHERE singleton = 1").toArray()[0]?.surface_opacity,
        surfaceColumns: state.storage.sql.exec<{ name: string }>("PRAGMA table_info(wc_meta)").toArray().map(({ name }) => name),
        versions: state.storage.sql.exec<{ version: number }>("SELECT version FROM _sql_schema_migrations ORDER BY version").toArray().map(({ version }) => version),
      };
    });

    expect(placement.placement).toEqual({ style_id: "plain-list", numbered: 1, placement_x: 300, placement_y: 8, placement_scale: 1, global_timer_mode: "down" });
    expect(placement.versions).toContain(8);
    expect(placement.versions).toContain(10);
    expect(placement.versions).toContain(12);
    expect(placement.versions).toContain(13);
    expect(placement.versions).toContain(16);
    expect(placement.headerStyle).toBe("default");
    expect(placement.textEmphasis).toBe("auto");
    expect(placement.fontSettings).toEqual({ font_family: "theme", font_scale: 1 });
    expect(placement.surfaceOpacity).toBe(100);
    expect(placement.surfaceColumns).toEqual([
      "singleton",
      "event_seq",
      "board_revision",
      "settings_revision",
      "style_id",
      "theme_mode",
      "surface_opacity",
      "header_style",
      "text_emphasis",
      "font_family",
      "font_scale",
      "header_title",
      "penalty_label",
      "penalty_text",
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
      "key_visible",
    ]);
    const columns = await runInDurableObject(legacyStub, (_instance, state) => state.storage.sql.exec<{ name: string }>("PRAGMA table_info(wc_meta)").toArray().map(({ name }) => name));
    expect(columns).toContain("max_visible");
    expect(columns).toContain("header_style");
    expect(columns).toContain("font_family");
    expect(columns).toContain("font_scale");
  });

  it("baut die alte max_visible-Tabelle um und erhält alle übrigen Meta-Werte", async () => {
    const result = await runInDurableObject(migrationElevenStub, (_instance, state) => {
      state.storage.sql.exec(`
        DROP TABLE IF EXISTS wc_meta;
        DROP TABLE IF EXISTS _sql_schema_migrations;
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
          theme_mode TEXT NOT NULL CHECK (theme_mode IN ('inherit', 'own')),
          surface_mode TEXT NOT NULL CHECK (surface_mode IN ('surface', 'bare')),
          header_style TEXT NOT NULL DEFAULT 'default' CHECK (header_style IN ('default','inverted')),
          header_title TEXT NOT NULL,
          effects_enabled INTEGER NOT NULL CHECK (effects_enabled IN (0, 1)),
          max_visible INTEGER NOT NULL DEFAULT 5 CHECK (max_visible BETWEEN 3 AND 10),
          overflow_mode TEXT NOT NULL DEFAULT 'cut' CHECK (overflow_mode IN ('cut', 'page', 'scroll')),
          overflow_tempo TEXT NOT NULL DEFAULT 'medium' CHECK (overflow_tempo IN ('slow', 'medium', 'fast')),
          numbered INTEGER NOT NULL DEFAULT 0 CHECK (numbered IN (0, 1)),
          done_order TEXT NOT NULL DEFAULT 'end' CHECK (done_order IN ('end', 'keep')),
          global_timer_mode TEXT NOT NULL DEFAULT 'down' CHECK (global_timer_mode IN ('down', 'up')),
          placement_x INTEGER NOT NULL DEFAULT 300 CHECK (placement_x BETWEEN 0 AND 384),
          placement_y INTEGER NOT NULL DEFAULT 8 CHECK (placement_y BETWEEN 0 AND 216),
          placement_scale REAL NOT NULL DEFAULT 1 CHECK (placement_scale BETWEEN 0.75 AND 2),
          global_timer_total_ms INTEGER,
          global_timer_ends_at TEXT,
          global_timer_paused_remain_ms INTEGER,
          CHECK (global_timer_ends_at IS NULL OR global_timer_paused_remain_ms IS NULL),
          CHECK (
            global_timer_total_ms IS NOT NULL
            OR (global_timer_ends_at IS NULL AND global_timer_paused_remain_ms IS NULL)
          )
        );
        INSERT INTO _sql_schema_migrations(version, build_id, applied_at) VALUES
          (1, 'legacy', '2026-08-30T12:00:00.000Z'),
          (2, 'legacy', '2026-08-30T12:00:00.000Z'),
          (3, 'legacy', '2026-08-30T12:00:00.000Z'),
          (4, 'legacy', '2026-08-30T12:00:00.000Z'),
          (5, 'legacy', '2026-08-30T12:00:00.000Z'),
          (6, 'legacy', '2026-08-30T12:00:00.000Z'),
          (7, 'legacy', '2026-08-30T12:00:00.000Z'),
          (8, 'legacy', '2026-08-30T12:00:00.000Z'),
          (9, 'legacy', '2026-08-30T12:00:00.000Z'),
          (10, 'legacy', '2026-08-30T12:00:00.000Z');
        INSERT INTO wc_meta(
          singleton, event_seq, board_revision, settings_revision, style_id,
          theme_mode, surface_mode, header_style, header_title, effects_enabled,
          max_visible, overflow_mode, overflow_tempo, numbered, done_order,
          global_timer_mode, placement_x, placement_y, placement_scale,
          global_timer_total_ms, global_timer_ends_at, global_timer_paused_remain_ms
        ) VALUES (
          1, 42, 7, 8, 'quest-log', 'own', 'bare', 'inverted', 'Legacy', 0,
          10, 'scroll', 'fast', 1, 'keep', 'up', 123, 45, 1.25,
          100000, NULL, NULL
        );
      `);
      runMigrations(state.storage.sql, "worker-test-migration-11");
      state.storage.sql.exec("UPDATE wc_meta SET max_visible = 20 WHERE singleton = 1");
      runMigrations(state.storage.sql, "worker-test-migration-11-second-run");
      return {
        versions: state.storage.sql
          .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations ORDER BY version")
          .toArray()
          .map(({ version }) => version),
        meta: state.storage.sql.exec<{
          singleton: number;
          event_seq: number;
          board_revision: number;
          settings_revision: number;
          style_id: string;
          theme_mode: string;
          surface_opacity: number;
          header_style: string;
          text_emphasis: string;
          font_family: string;
          font_scale: number;
          header_title: string;
          penalty_text: string;
          effects_enabled: number;
          max_visible: number;
          overflow_mode: string;
          overflow_tempo: string;
          numbered: number;
          key_visible: number;
          done_order: string;
          global_timer_mode: string;
          placement_x: number;
          placement_y: number;
          placement_scale: number;
          global_timer_total_ms: number | null;
          global_timer_ends_at: string | null;
          global_timer_paused_remain_ms: number | null;
        }>("SELECT singleton, event_seq, board_revision, settings_revision, style_id, theme_mode, surface_opacity, header_style, text_emphasis, font_family, font_scale, header_title, penalty_text, effects_enabled, max_visible, overflow_mode, overflow_tempo, numbered, key_visible, done_order, global_timer_mode, placement_x, placement_y, placement_scale, global_timer_total_ms, global_timer_ends_at, global_timer_paused_remain_ms FROM wc_meta WHERE singleton = 1").toArray()[0],
      };
    });

    expect(result.versions).toContain(11);
    expect(result.versions).toContain(12);
    expect(result.versions).toContain(13);
    expect(result.meta).toEqual({
      singleton: 1,
      event_seq: 42,
      board_revision: 7,
      settings_revision: 8,
      style_id: "quest-log",
      theme_mode: "own",
      surface_opacity: 0,
      header_style: "inverted",
      text_emphasis: "auto",
      font_family: "theme",
      font_scale: 1,
      header_title: "Legacy",
      penalty_text: "",
      effects_enabled: 0,
      max_visible: 20,
      overflow_mode: "scroll",
      overflow_tempo: "fast",
      numbered: 1,
      key_visible: 0,
      done_order: "keep",
      global_timer_mode: "up",
      placement_x: 123,
      placement_y: 45,
      placement_scale: 1.25,
      global_timer_total_ms: 100000,
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

  it("speichert und lädt die Flächenopazität im Repository-Roundtrip", async () => {
    const before = await inRepository((repository) => repository.readSnapshot());
    await inRepository((repository) => repository.saveSettings({
      baseSettingsRevision: before.settingsRevision,
      styleId: before.settings.styleId,
      themeMode: before.settings.themeMode,
      surfaceOpacity: 25,
      headerStyle: before.settings.headerStyle,
      textEmphasis: before.settings.textEmphasis,
      fontFamily: before.settings.fontFamily,
      fontScale: before.settings.fontScale,
      headerTitle: before.settings.headerTitle,
      penaltyLabel: "Konsequenz",
      penaltyText: "Die nächste Challenge wird doppelt schwer.",
      effectsEnabled: before.settings.effectsEnabled,
      maxVisible: before.settings.maxVisible,
      overflowMode: before.settings.overflowMode,
      overflowTempo: before.settings.overflowTempo,
      numbered: before.settings.numbered,
      keyVisible: true,
      doneOrder: before.settings.doneOrder,
      globalTimerMode: before.settings.globalTimerMode,
      globalTimerTotalMs: before.settings.globalTimer?.totalMs ?? null,
      placement: before.settings.placement,
      now,
    }));

    expect((await inRepository((repository) => repository.readSnapshot())).settings).toMatchObject({
      surfaceOpacity: 25,
      penaltyLabel: "Konsequenz",
      keyVisible: true,
      penaltyText: "Die nächste Challenge wird doppelt schwer.",
    });
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

  it("enforces the range CHECK for the paused challenge timer", async () => {
    await inRepository((repository) =>
      repository.saveBoard({ baseBoardRevision: 1, definitions: [definition("Paused", 0)], now }),
    );
    const rejected = await runInDurableObject(stub, (_instance, state) => {
      const id = state.storage.sql.exec<{ id: string }>("SELECT id FROM wc_challenges LIMIT 1").toArray()[0]?.id;
      if (id === undefined) throw new Error("Challenge fehlt.");
      try {
        state.storage.sql.exec("UPDATE wc_challenges SET timer_remain_ms = ? WHERE id = ?", 21_600_001, id);
      } catch {
        return true;
      }
      return false;
    });

    expect(rejected).toBe(true);
  });

  it("führt Migration 9 auf einer Version-8-Tabelle ohne Restzeitspalte aus", async () => {
    const result = await runInDurableObject(migrationNineStub, (_instance, state) => {
      state.storage.sql.exec(`
        DROP TABLE IF EXISTS wc_challenges;
        DROP TABLE IF EXISTS _sql_schema_migrations;
        CREATE TABLE _sql_schema_migrations (
          version INTEGER PRIMARY KEY,
          build_id TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE wc_challenges (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          target_count INTEGER,
          timer_total_ms INTEGER,
          sort_order INTEGER NOT NULL,
          current_count INTEGER NOT NULL,
          state TEXT NOT NULL,
          timer_ends_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          hidden INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO _sql_schema_migrations(version, build_id, applied_at) VALUES
          (1, 'legacy', '2026-08-30T12:00:00.000Z'),
          (2, 'legacy', '2026-08-30T12:00:00.000Z'),
          (3, 'legacy', '2026-08-30T12:00:00.000Z'),
          (4, 'legacy', '2026-08-30T12:00:00.000Z'),
          (5, 'legacy', '2026-08-30T12:00:00.000Z'),
          (6, 'legacy', '2026-08-30T12:00:00.000Z'),
          (7, 'legacy', '2026-08-30T12:00:00.000Z'),
          (8, 'legacy', '2026-08-30T12:00:00.000Z');
      `);
      runMigrations(state.storage.sql, "worker-test-migration-9");
      const columns = state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(wc_challenges)")
        .toArray()
        .map(({ name }) => name);
      let rangeCheckRejected = false;
      try {
        state.storage.sql.exec(
          "INSERT INTO wc_challenges(id, title, sort_order, current_count, state, timer_remain_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          "legacy-challenge",
          "Legacy",
          0,
          0,
          "pending",
          21_600_001,
          now,
          now,
        );
      } catch {
        rangeCheckRejected = true;
      }
      return { columns, rangeCheckRejected };
    });

    expect(result.columns).toContain("timer_remain_ms");
    expect(result.rangeCheckRejected).toBe(true);
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
            timerRemainMs: null,
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

  it("persistiert den Bestwert-Reset beim Typwechsel", async () => {
    const created = await inRepository((repository) =>
      repository.saveBoard({ baseBoardRevision: 1, definitions: [definition("Counter", 0)], now }),
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
            timerRemainMs: null,
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
        definitions: [{
          ...definitionFor(runtime, "Streak"),
          kind: "streak",
          targetCount: 5,
        }],
        now: future,
      }),
    );

    expect(onlyChallenge(saved.snapshot.challenges)).toMatchObject({
      kind: "streak",
      currentCount: 0,
      bestCount: 0,
      state: "pending",
    });
  });

  it("bewahrt einen übererfüllten measure-Stand beim Board-Save", async () => {
    const created = await inRepository((repository) =>
      repository.saveBoard({
        baseBoardRevision: 1,
        definitions: [{
          ...definition("Meter", 0),
          kind: "measure",
          unit: "m",
          targetCount: 1_500,
          step: 50,
        }],
        now,
      }),
    );
    const seeded = onlyChallenge(created.snapshot.challenges);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE wc_challenges SET current_count = 1800 WHERE id = ?", seeded.id);
    });

    const saved = await inRepository((repository) =>
      repository.saveBoard({
        baseBoardRevision: created.snapshot.boardRevision,
        definitions: [definitionFor(seeded, "Meter")],
        now,
      }),
    );

    expect(onlyChallenge(saved.snapshot.challenges)).toMatchObject({
      kind: "measure",
      currentCount: 1_800,
      targetCount: 1_500,
    });
  });

  it("vergibt serverseitige Steuer-Keys für alle neuen Geschwister", async () => {
    const saved = await inRepository((repository) =>
      repository.saveBoard({
        baseBoardRevision: 1,
        definitions: [definition("Eins", 0), definition("Zwei", 1), definition("Drei", 2)],
        now,
      }),
    );
    const keys = saved.snapshot.challenges.map(({ controlKey }) => controlKey);

    expect(keys).toHaveLength(3);
    expect(new Set(keys.map((key) => key.toUpperCase())).size).toBe(3);
    for (const key of keys) expect(key).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  });

  it("behält den Steuer-Key beim Umbenennen und schreibt gelöschte Keys als Tombstones", async () => {
    const created = await inRepository((repository) =>
      repository.saveBoard({ baseBoardRevision: 1, definitions: [definition("Original", 0)], now }),
    );
    const seeded = onlyChallenge(created.snapshot.challenges);
    const renamed = await inRepository((repository) =>
      repository.saveBoard({
        baseBoardRevision: created.snapshot.boardRevision,
        definitions: [definitionFor(seeded, "Umbenannt")],
        now: future,
      }),
    );

    expect(onlyChallenge(renamed.snapshot.challenges).controlKey).toBe(seeded.controlKey);

    await inRepository((repository) =>
      repository.saveBoard({ baseBoardRevision: renamed.snapshot.boardRevision, definitions: [], now: future }),
    );
    const retired = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ control_key: string }>("SELECT control_key FROM wc_retired_keys").toArray(),
    );

    expect(retired).toEqual([{ control_key: seeded.controlKey }]);
  });

  it("löscht bei einer Teilaktualisierung genau zwei von fünf Challenges", async () => {
    const created = await inRepository((repository) =>
      repository.saveBoard({
        baseBoardRevision: 1,
        definitions: [
          definition("Eins", 0),
          definition("Zwei", 1),
          definition("Drei", 2),
          definition("Vier", 3),
          definition("Fünf", 4),
        ],
        now,
      }),
    );
    const removed = [created.snapshot.challenges[1], created.snapshot.challenges[3]];
    const kept = [created.snapshot.challenges[0], created.snapshot.challenges[2], created.snapshot.challenges[4]];
    if (removed.some((challenge) => challenge === undefined) || kept.some((challenge) => challenge === undefined)) {
      throw new Error("Fünf Challenges wurden nicht angelegt.");
    }
    const removedChallenges = removed.filter((challenge): challenge is Challenge => challenge !== undefined);
    const keptChallenges = kept.filter((challenge): challenge is Challenge => challenge !== undefined);

    const updated = await inRepository((repository) =>
      repository.saveBoard({
        baseBoardRevision: created.snapshot.boardRevision,
        definitions: keptChallenges.map((challenge) => definitionFor(challenge, challenge.title)),
        now: future,
      }),
    );
    const retired = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ control_key: string }>("SELECT control_key FROM wc_retired_keys ORDER BY rowid").toArray(),
    );

    expect(updated.snapshot.challenges.map(({ id }) => id)).toEqual(keptChallenges.map(({ id }) => id));
    expect(retired).toEqual(removedChallenges.map((challenge) => ({ control_key: challenge.controlKey })));
  });

  it("hinterlässt bei einem scheiternden DELETE keinen Tombstone", async () => {
    const created = await inRepository((repository) =>
      repository.saveBoard({ baseBoardRevision: 1, definitions: [definition("Gesperrt", 0)], now }),
    );
    const challenge = onlyChallenge(created.snapshot.challenges);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("PRAGMA foreign_keys = ON");
      state.storage.sql.exec(`
        CREATE TABLE wc_delete_blocker (
          challenge_id TEXT PRIMARY KEY REFERENCES wc_challenges(id)
        );
      `);
      state.storage.sql.exec(
        "INSERT INTO wc_delete_blocker(challenge_id) VALUES (?)",
        challenge.id,
      );
    });

    let observation: {
      challenges: readonly { id: string }[];
      retired: readonly { control_key: string }[];
    } | undefined;
    try {
      await expect(inRepository((repository) =>
        repository.saveBoard({ baseBoardRevision: created.snapshot.boardRevision, definitions: [], now: future }),
      )).rejects.toThrow();
    } finally {
      observation = await runInDurableObject(stub, (_instance, state) => {
        const result = {
          challenges: state.storage.sql.exec<{ id: string }>("SELECT id FROM wc_challenges ORDER BY id").toArray(),
          retired: state.storage.sql.exec<{ control_key: string }>("SELECT control_key FROM wc_retired_keys ORDER BY rowid").toArray(),
        };
        state.storage.sql.exec("PRAGMA foreign_keys = OFF");
        state.storage.sql.exec("DROP TABLE wc_delete_blocker");
        return result;
      });
    }

    expect(observation).toEqual({
      challenges: [{ id: challenge.id }],
      retired: [],
    });
  });

  it("lässt controlKey nicht aus einer Client-Definition setzen", async () => {
    const clientDefinition = {
      ...definition("Client-Key", 0),
      controlKey: "AAAA",
    } as unknown as ChallengeDefinition;

    await expect(inRepository((repository) =>
      repository.saveBoard({ baseBoardRevision: 1, definitions: [clientDefinition], now }),
    )).rejects.toThrow("Ungültige Challenge-Definition.");
  });

  it("liest und schreibt eine pausierte Challenge-Restzeit im Roundtrip", async () => {
    const created = await inRepository((repository) =>
      repository.saveBoard({ baseBoardRevision: 1, definitions: [definition("Roundtrip", 0)], now }),
    );
    const seeded = onlyChallenge(created.snapshot.challenges);
    const updated = await inRepository((repository) =>
      repository.transaction((transaction) =>
        transaction.updateChallengeRuntime(
          seeded.id,
          {
            currentCount: seeded.currentCount,
            state: "pending",
            timerEndsAt: null,
            timerRemainMs: 3_120,
            completedAt: null,
            hidden: false,
          },
          future,
        ),
      ),
    );

    expect(updated).toMatchObject({ timerEndsAt: null, timerRemainMs: 3_120 });
    expect(onlyChallenge((await inRepository((repository) => repository.readSnapshot())).challenges))
      .toMatchObject({ timerEndsAt: null, timerRemainMs: 3_120 });
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
        surfaceOpacity: 0,
        headerStyle: "inverted",
        textEmphasis: "strong",
        fontFamily: "mono",
        fontScale: 1.5,
        headerTitle: "RUN",
        penaltyLabel: "STRAFE",
        penaltyText: "",
        effectsEnabled: false,
        maxVisible: 8,
        overflowMode: "page",
        overflowTempo: "fast",
        numbered: true,
        keyVisible: true,
        doneOrder: "keep",
        globalTimerMode: "up",
        globalTimerTotalMs: 86_400_000,
        placement: { x: 12, y: 34, scale: 1.25 },
        now: future,
      }),
    );

    expect(saved.snapshot.settings).toMatchObject({
      styleId: "plain-list",
      themeMode: "own",
      surfaceOpacity: 0,
      headerStyle: "inverted",
      textEmphasis: "strong",
      fontFamily: "mono",
      fontScale: 1.5,
      headerTitle: "RUN",
      penaltyLabel: "STRAFE",
      penaltyText: "",
      effectsEnabled: false,
      overflowMode: "page",
      overflowTempo: "fast",
      numbered: true,
      keyVisible: true,
      doneOrder: "keep",
      placement: { x: 12, y: 34, scale: 1.25 },
      globalTimer: { totalMs: 86_400_000, endsAt: null, pausedRemainMs: null },
      globalTimerMode: "up",
    });
    const reloaded = await inRepository((repository) => repository.readSnapshot());
    expect(reloaded.settings).toMatchObject({ textEmphasis: "strong", fontFamily: "mono", fontScale: 1.5 });
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
        overflowMode: "cut", overflowTempo: "medium", numbered: false, keyVisible: false, doneOrder: "end",
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
        overflowMode: "cut", overflowTempo: "medium", numbered: false, keyVisible: false, doneOrder: "end",
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

  it("führt den Bestwert über atomare Increments mit und bewahrt ihn bei Rückgang", async () => {
    const created = await inRepository((repository) =>
      repository.saveBoard({ baseBoardRevision: 1, definitions: [definition("Counter", 0)], now: now }),
    );
    const challenge = onlyChallenge(created.snapshot.challenges);
    const counts = await inRepository((repository) =>
      repository.transaction((transaction) => {
        const first = transaction.incrementChallengeCount(challenge.id, 1, 10, now);
        const second = transaction.incrementChallengeCount(challenge.id, 1, 10, now);
        const fallen = transaction.incrementChallengeCount(challenge.id, -1, 10, now);
        return [
          first?.currentCount ?? null,
          first?.bestCount ?? null,
          second?.currentCount ?? null,
          second?.bestCount ?? null,
          fallen?.currentCount ?? null,
          fallen?.bestCount ?? null,
        ];
      }),
    );

    expect(counts).toEqual([1, 1, 2, 2, 1, 2]);
    expect(await inRepository((repository) => repository.readChallenge(challenge.id))).toMatchObject({
      currentCount: 1,
      bestCount: 2,
    });
  });

  it("führt measure-Increments über das Ziel hinaus und liest sie wieder aus der Datenbank", async () => {
    const created = await inRepository((repository) =>
      repository.saveBoard({
        baseBoardRevision: 1,
        definitions: [{
          ...definition("Meter", 0),
          kind: "measure",
          unit: "m",
          targetCount: 1_500,
          step: 50,
        }],
        now,
      }),
    );
    const challenge = onlyChallenge(created.snapshot.challenges);
    const executeIncrement = async (delta: number, commandId: string) => {
      const command = {
        commandId,
        scope: "challenge" as const,
        type: "increment" as const,
        challengeId: challenge.id,
        delta,
      };
      const requestHash = await hashChallengeCommand(command);
      return inRepository((repository) =>
        createWinChallenges({ repository, clock: () => now }).executeCommandWithHash(
          command,
          requestHash,
        ),
      );
    };

    await inRepository((repository) => repository.transaction((transaction) =>
      transaction.updateChallengeRuntime(
        challenge.id,
        {
          currentCount: 1_500,
          state: "pending",
          timerEndsAt: null,
          timerRemainMs: null,
          completedAt: null,
          hidden: false,
        },
        now,
      ),
    ));
    const first = await executeIncrement(50, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const second = await executeIncrement(250, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    expect(first.response.challenge).toMatchObject({ currentCount: 1_550, state: "pending" });
    expect(second.response.challenge).toMatchObject({ currentCount: 1_800, state: "pending" });
    expect((await inRepository((repository) => repository.readChallenge(challenge.id)))?.currentCount)
      .toBe(1_800);
  });

  it("weist einen ungültigen measure-großen Counter-Stand beim DB-Readback zurück", async () => {
    const created = await inRepository((repository) =>
      repository.saveBoard({ baseBoardRevision: 1, definitions: [definition("Counter", 0)], now }),
    );
    const challenge = onlyChallenge(created.snapshot.challenges);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE wc_challenges SET current_count = 1000000 WHERE id = ?", challenge.id);
    });

    await expect(inRepository((repository) => repository.readChallenge(challenge.id))).rejects.toThrow();
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
        overflowMode: "cut", overflowTempo: "medium", numbered: false, keyVisible: false, doneOrder: "end",
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
          overflowMode: "cut", overflowTempo: "medium", numbered: false, keyVisible: false, doneOrder: "end",
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
    expect(mutation).toMatchObject({ rowsWritten: 4, rowsRead: 6 });
    // Migration 17 adds one case-insensitive UNIQUE-index write per new
    // control_key (3 writes). Measured reads increase by 3, from 15 to 18.
    // The retired-key set is loaded once per saveBoard; current.challenges
    // supplies the tombstone candidates, so neither path adds per-candidate reads.
    expect(board).toMatchObject({ rowsWritten: 10, rowsRead: 18 });
    expect(settings).toMatchObject({ rowsWritten: 1, rowsRead: 20 });
    expect(snapshot).toMatchObject({ rowsWritten: 0, rowsRead: 7 });
  });
});
