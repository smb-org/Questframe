import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { runMigrations } from "../../src/channel/migrations";
import MIGRATIONS_SOURCE from "../../src/channel/migrations.ts?raw";
import CONTROL_KEYS_SOURCE from "../../src/modules/win-challenges/domain/control-keys.ts?raw";
import { MAX_CHALLENGES } from "../../src/modules/win-challenges/contracts/predicates";
import {
  readSchemaSnapshot,
  withHistoricalDatabase as withHarnessDatabase,
  type SchemaSnapshot,
} from "./migrations-harness";

const FIXTURE_TIMESTAMP = "2026-08-30T12:00:00.000Z";
const HISTORICAL_VERSIONS = Array.from({ length: 16 }, (_, index) => index + 1) as HistoricalSchemaVersion[];
const CURRENT_VERSIONS = Array.from({ length: 17 }, (_, index) => index + 1);
const ALL_SCHEMA_VERSIONS = [0, ...HISTORICAL_VERSIONS] as HistoricalSchemaVersion[];
const RECOVERABLE_CRASH_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as HistoricalSchemaVersion[];

export type HistoricalSchemaVersion = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;

export type DatabaseSnapshot = {
  schema: SchemaSnapshot;
  data: Readonly<Record<string, readonly Record<string, SqlStorageValue>[]>>;
};

const BASE_SCHEMA_WITHOUT_OVERLAY_ENVELOPE = `
CREATE TABLE _sql_schema_migrations (
  version INTEGER PRIMARY KEY,
  build_id TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TABLE channel_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL,
  overlay_enabled INTEGER NOT NULL CHECK (overlay_enabled IN (0, 1)),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_id TEXT NOT NULL,
  updated_by_name TEXT NOT NULL
);
CREATE TABLE state_history (
  revision INTEGER PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE editor_sessions (
  session_hash TEXT PRIMARY KEY,
  twitch_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  generation INTEGER NOT NULL,
  role_checked_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  access_token_envelope TEXT,
  refresh_token_envelope TEXT,
  token_expires_at TEXT
);
CREATE TABLE csrf_tokens (
  session_hash TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  previous_token_hash TEXT,
  previous_expires_at TEXT,
  PRIMARY KEY (session_hash, tab_id)
);
CREATE TABLE oauth_nonces (
  nonce_hash TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  pkce_verifier TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE overlay_tokens (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  token_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  generation INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  creating_session_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE media_blobs (
  content_hash TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE media_leases (
  content_hash TEXT NOT NULL,
  editor_session_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (content_hash, editor_session_hash)
);
CREATE TABLE twitch_user_cache (
  twitch_user_id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  portrait_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX audit_created_idx ON audit_log(created_at DESC);
CREATE INDEX history_created_idx ON state_history(created_at DESC);
`;

const WC_META_SCHEMA_V3 = `
CREATE TABLE wc_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  event_seq INTEGER NOT NULL,
  board_revision INTEGER NOT NULL,
  settings_revision INTEGER NOT NULL,
  style_id TEXT NOT NULL,
  theme_mode TEXT NOT NULL CHECK (theme_mode IN ('inherit', 'own')),
  surface_mode TEXT NOT NULL CHECK (surface_mode IN ('surface', 'bare')),
  header_title TEXT NOT NULL,
  effects_enabled INTEGER NOT NULL CHECK (effects_enabled IN (0, 1)),
  max_visible INTEGER NOT NULL CHECK (max_visible BETWEEN 3 AND 10),
  global_timer_total_ms INTEGER,
  global_timer_ends_at TEXT,
  global_timer_paused_remain_ms INTEGER,
  CHECK (global_timer_ends_at IS NULL OR global_timer_paused_remain_ms IS NULL),
  CHECK (
    global_timer_total_ms IS NOT NULL
    OR (global_timer_ends_at IS NULL AND global_timer_paused_remain_ms IS NULL)
  )
);
`;

const WC_META_SCHEMA_V3_RECOVERY = WC_META_SCHEMA_V3.replace(
  "surface_mode TEXT NOT NULL CHECK (surface_mode IN ('surface', 'bare'))",
  "surface_mode TEXT NOT NULL DEFAULT 'bare' CHECK (surface_mode IN ('surface', 'bare'))",
);

const WC_CHALLENGES_SCHEMA_V3 = `
CREATE TABLE wc_challenges (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  target_count INTEGER,
  timer_total_ms INTEGER,
  sort_order INTEGER NOT NULL,
  current_count INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'done')),
  timer_ends_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE wc_commands (
  command_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE wc_dock_tokens (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  token_hash TEXT NOT NULL,
  token_envelope TEXT,
  fingerprint TEXT NOT NULL,
  generation INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  creating_session_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
`;

const WC_META_REBUILD_TARGET_V11 = `
CREATE TABLE wc_meta_migration_11 (
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
  max_visible INTEGER NOT NULL DEFAULT 5 CHECK (max_visible BETWEEN 3 AND 20),
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
`;

const WC_META_COPY_V11 = `
INSERT INTO wc_meta_migration_11(
  singleton, event_seq, board_revision, settings_revision, style_id,
  theme_mode, surface_mode, header_style, header_title, effects_enabled,
  max_visible, overflow_mode, overflow_tempo, numbered, done_order,
  global_timer_mode, placement_x, placement_y, placement_scale,
  global_timer_total_ms, global_timer_ends_at, global_timer_paused_remain_ms
)
SELECT
  singleton, event_seq, board_revision, settings_revision, style_id,
  theme_mode, surface_mode, header_style, header_title, effects_enabled,
  max_visible, overflow_mode, overflow_tempo, numbered, done_order,
  global_timer_mode, placement_x, placement_y, placement_scale,
  global_timer_total_ms, global_timer_ends_at, global_timer_paused_remain_ms
FROM wc_meta;
`;

const WC_META_SCHEMA_V11 = `${WC_META_REBUILD_TARGET_V11}${WC_META_COPY_V11}
DROP TABLE wc_meta;
ALTER TABLE wc_meta_migration_11 RENAME TO wc_meta;
`;

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const createTableNames = (sql: SqlStorage): string[] =>
  sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .toArray()
    .map(({ name }) => name);

const resetDatabase = (sql: SqlStorage): void => {
  for (const tableName of [
    "wc_meta_migration_11",
    "wc_meta",
    "wc_challenges",
    "wc_commands",
    "wc_dock_tokens",
    "_sql_schema_migrations",
    "channel_state",
    "state_history",
    "audit_log",
    "editor_sessions",
    "csrf_tokens",
    "oauth_nonces",
    "overlay_tokens",
    "media_blobs",
    "media_leases",
    "twitch_user_cache",
    "wc_retired_keys",
  ]) {
    sql.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
  }
};

const insertMigrationLedger = (sql: SqlStorage, version: number): void => {
  for (let appliedVersion = 1; appliedVersion <= version; appliedVersion += 1) {
    sql.exec(
      "INSERT INTO _sql_schema_migrations(version, build_id, applied_at) VALUES (?, ?, ?)",
      appliedVersion,
      `fixture-v${String(appliedVersion)}`,
      FIXTURE_TIMESTAMP,
    );
  }
};

const seedBaseData = (sql: SqlStorage): void => {
  sql.exec(`
    INSERT INTO channel_state(
      singleton, revision, overlay_enabled, state_json, updated_at, updated_by_id, updated_by_name
    ) VALUES (1, 7, 1, '{"fixture":true}', '${FIXTURE_TIMESTAMP}', 'fixture-user', 'Fixture');
    INSERT INTO state_history(revision, snapshot_json, created_at, summary)
    VALUES (7, '{"fixture":true}', '${FIXTURE_TIMESTAMP}', 'Fixture-Zustand');
    INSERT INTO audit_log(id, revision, action, actor_id, actor_name, summary, created_at)
    VALUES ('fixture-audit', 7, 'fixture', 'fixture-user', 'Fixture', 'Fixture-Eintrag', '${FIXTURE_TIMESTAMP}');
  `);
};

const seedChallengeData = (sql: SqlStorage): void => {
  sql.exec(`
    INSERT INTO wc_meta(
      singleton, event_seq, board_revision, settings_revision, style_id, theme_mode,
      surface_mode, header_title, effects_enabled, max_visible,
      global_timer_total_ms, global_timer_ends_at, global_timer_paused_remain_ms
    ) VALUES (1, 42, 7, 8, 'plain-numbered', 'inherit', 'bare', 'Historisches Board', 0, 10, 120000, NULL, NULL);
    INSERT INTO wc_challenges(
      id, title, description, target_count, timer_total_ms, sort_order, current_count,
      state, timer_ends_at, completed_at, created_at, updated_at
    ) VALUES
      ('fixture-done', 'Erledigte Challenge', 'Legacy-Beschreibung', 3, 60000, 1, 3,
        'done', '2026-08-30T12:30:00.000Z', '2026-08-30T12:31:00.000Z', '${FIXTURE_TIMESTAMP}', '${FIXTURE_TIMESTAMP}'),
      ('fixture-active', 'Aktive Challenge', 'Bleibt erhalten', 5, 90000, 2, 2,
        'active', '2026-08-30T12:45:00.000Z', NULL, '${FIXTURE_TIMESTAMP}', '${FIXTURE_TIMESTAMP}');
    INSERT INTO wc_commands(command_id, request_hash, created_at)
    VALUES ('fixture-command', 'fixture-request-hash', '${FIXTURE_TIMESTAMP}');
    INSERT INTO wc_dock_tokens(
      singleton, token_hash, token_envelope, fingerprint, generation, request_id,
      creating_session_hash, created_at, last_used_at
    ) VALUES (1, 'fixture-token-hash', 'fixture-token-envelope', 'fixture-fingerprint', 3,
      'fixture-request', 'fixture-session', '${FIXTURE_TIMESTAMP}', NULL);
  `);
};

const applyHistoricalChallengeSchema = (sql: SqlStorage, version: HistoricalSchemaVersion): void => {
  if (version < 3) return;

  sql.exec(`${WC_META_SCHEMA_V3}${WC_CHALLENGES_SCHEMA_V3}`);
  seedChallengeData(sql);

  if (version >= 4) {
    sql.exec("ALTER TABLE wc_challenges ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));");
    sql.exec("UPDATE wc_challenges SET timer_ends_at = NULL WHERE state = 'done' AND timer_ends_at IS NOT NULL");
  }
  if (version >= 5) {
    sql.exec(`
      ALTER TABLE wc_meta ADD COLUMN placement_x INTEGER NOT NULL DEFAULT 300 CHECK (placement_x BETWEEN 0 AND 384);
      ALTER TABLE wc_meta ADD COLUMN placement_y INTEGER NOT NULL DEFAULT 8 CHECK (placement_y BETWEEN 0 AND 216);
      ALTER TABLE wc_meta ADD COLUMN placement_scale REAL NOT NULL DEFAULT 1 CHECK (placement_scale BETWEEN 0.75 AND 2);
    `);
  }
  if (version >= 6) {
    sql.exec("ALTER TABLE wc_challenges DROP COLUMN description;");
  }
  if (version >= 7) {
    sql.exec(`
      ALTER TABLE wc_meta ADD COLUMN overflow_mode TEXT NOT NULL DEFAULT 'cut' CHECK (overflow_mode IN ('cut','page','scroll'));
      ALTER TABLE wc_meta ADD COLUMN overflow_tempo TEXT NOT NULL DEFAULT 'medium' CHECK (overflow_tempo IN ('slow','medium','fast'));
      ALTER TABLE wc_meta ADD COLUMN numbered INTEGER NOT NULL DEFAULT 0 CHECK (numbered IN (0,1));
      ALTER TABLE wc_meta ADD COLUMN done_order TEXT NOT NULL DEFAULT 'end' CHECK (done_order IN ('end','keep'));
      UPDATE wc_meta SET style_id = 'plain-list', numbered = 1 WHERE style_id = 'plain-numbered';
    `);
  }
  if (version >= 8) {
    sql.exec("ALTER TABLE wc_meta ADD COLUMN global_timer_mode TEXT NOT NULL DEFAULT 'down' CHECK (global_timer_mode IN ('down','up'));");
  }
  if (version >= 9) {
    sql.exec("ALTER TABLE wc_challenges ADD COLUMN timer_remain_ms INTEGER CHECK (timer_remain_ms BETWEEN 0 AND 21600000);");
  }
  if (version >= 10) {
    sql.exec("ALTER TABLE wc_meta ADD COLUMN header_style TEXT NOT NULL DEFAULT 'default' CHECK (header_style IN ('default','inverted'));");
  }
  if (version >= 11) {
    sql.exec(WC_META_SCHEMA_V11);
  }
  if (version >= 12) {
    sql.exec(`
      ALTER TABLE wc_meta ADD COLUMN font_family TEXT NOT NULL DEFAULT 'theme' CHECK (font_family IN ('theme','atkinson','serif','sans','mono'));
      ALTER TABLE wc_meta ADD COLUMN font_scale REAL NOT NULL DEFAULT 1 CHECK (font_scale BETWEEN 0.75 AND 2);
    `);
  }
  if (version >= 13) {
    sql.exec("ALTER TABLE wc_meta ADD COLUMN surface_opacity INTEGER NOT NULL DEFAULT 100 CHECK (surface_opacity IN (0,25,50,75,100));");
    sql.exec("UPDATE wc_meta SET surface_opacity = CASE surface_mode WHEN 'bare' THEN 0 ELSE 100 END;");
    sql.exec("ALTER TABLE wc_meta DROP COLUMN surface_mode;");
  }
  if (version >= 14) {
    sql.exec("ALTER TABLE wc_meta ADD COLUMN penalty_text TEXT NOT NULL DEFAULT '';");
  }
  if (version >= 15) {
    sql.exec("ALTER TABLE wc_meta ADD COLUMN penalty_label TEXT NOT NULL DEFAULT 'STRAFE';");
  }
  if (version >= 16) {
    sql.exec("ALTER TABLE wc_meta ADD COLUMN text_emphasis TEXT NOT NULL DEFAULT 'auto' CHECK (text_emphasis IN ('auto','strong','plain'));");
  }
};

/**
 * Baut einen historischen Stand ohne den aktuellen Migrationsrunner auf.
 * Die Stufen entsprechen den DDLs, die zum jeweiligen Release bereits in
 * Produktion angekommen waren. Eine neue Instanz wird erwartet.
 */
export const createHistoricalDatabase = (sql: SqlStorage, version: HistoricalSchemaVersion): void => {
  resetDatabase(sql);
  if (version === 0) return;

  sql.exec(BASE_SCHEMA_WITHOUT_OVERLAY_ENVELOPE);
  seedBaseData(sql);
  if (version >= 2) sql.exec("ALTER TABLE overlay_tokens ADD COLUMN token_envelope TEXT;");
  applyHistoricalChallengeSchema(sql, version);
  insertMigrationLedger(sql, version);
};

const createCurrentMigration3V16Database = (sql: SqlStorage): void => {
  resetDatabase(sql);
  sql.exec(BASE_SCHEMA_WITHOUT_OVERLAY_ENVELOPE);
  seedBaseData(sql);
  sql.exec("ALTER TABLE overlay_tokens ADD COLUMN token_envelope TEXT;");
  sql.exec(`
    CREATE TABLE wc_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      event_seq INTEGER NOT NULL,
      board_revision INTEGER NOT NULL,
      settings_revision INTEGER NOT NULL,
      style_id TEXT NOT NULL,
      theme_mode TEXT NOT NULL CHECK (theme_mode IN ('inherit', 'own')),
      surface_opacity INTEGER NOT NULL DEFAULT 100 CHECK (surface_opacity IN (0,25,50,75,100)),
      header_style TEXT NOT NULL DEFAULT 'default' CHECK (header_style IN ('default','inverted')),
      text_emphasis TEXT NOT NULL DEFAULT 'auto' CHECK (text_emphasis IN ('auto','strong','plain')),
      font_family TEXT NOT NULL DEFAULT 'theme' CHECK (font_family IN ('theme','atkinson','serif','sans','mono')),
      font_scale REAL NOT NULL DEFAULT 1 CHECK (font_scale BETWEEN 0.75 AND 2),
      header_title TEXT NOT NULL,
      penalty_label TEXT NOT NULL DEFAULT 'STRAFE',
      penalty_text TEXT NOT NULL DEFAULT '',
      effects_enabled INTEGER NOT NULL CHECK (effects_enabled IN (0, 1)),
      max_visible INTEGER NOT NULL DEFAULT 5 CHECK (max_visible BETWEEN 3 AND 20),
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
    CREATE TABLE wc_challenges (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      target_count INTEGER,
      timer_total_ms INTEGER,
      sort_order INTEGER NOT NULL,
      current_count INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'done')),
      timer_ends_at TEXT,
      timer_remain_ms INTEGER CHECK (timer_remain_ms BETWEEN 0 AND 21600000),
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (timer_ends_at IS NULL OR timer_remain_ms IS NULL)
    );
    CREATE TABLE wc_commands (
      command_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE wc_dock_tokens (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      token_hash TEXT NOT NULL,
      token_envelope TEXT,
      fingerprint TEXT NOT NULL,
      generation INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      creating_session_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    INSERT INTO wc_meta(
      singleton, event_seq, board_revision, settings_revision, style_id,
      theme_mode, surface_opacity, header_style, text_emphasis, font_family, font_scale,
      header_title, penalty_label, penalty_text, effects_enabled, max_visible,
      overflow_mode, overflow_tempo, numbered, done_order, global_timer_mode,
      placement_x, placement_y, placement_scale,
      global_timer_total_ms, global_timer_ends_at, global_timer_paused_remain_ms
    ) VALUES (
      1, 0, 1, 1, 'plain-list', 'inherit', 100, 'default', 'auto', 'theme', 1,
      'CHALLENGES', 'STRAFE', '', 1, 5,
      'cut', 'medium', 0, 'end', 'down',
      300, 8, 1, NULL, NULL, NULL
    );
    ALTER TABLE wc_challenges ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));
    ALTER TABLE wc_challenges DROP COLUMN description;
  `);
  insertMigrationLedger(sql, 16);
};

export const readDatabaseSnapshot = (sql: SqlStorage): DatabaseSnapshot => {
  const data: Record<string, readonly Record<string, SqlStorageValue>[]> = {};
  for (const tableName of createTableNames(sql)) {
    data[tableName] = sql
      .exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY rowid`)
      .toArray();
  }
  return { schema: readSchemaSnapshot(sql), data };
};

export const expectDatabaseSnapshot = (sql: SqlStorage, expected: DatabaseSnapshot): void => {
  expect(readDatabaseSnapshot(sql)).toEqual(expected);
};

export const createRecoverableCrashFixture = (sql: SqlStorage, version: HistoricalSchemaVersion): void => {
  if (version === 1) {
    resetDatabase(sql);
    sql.exec(BASE_SCHEMA_WITHOUT_OVERLAY_ENVELOPE);
    sql.exec("ALTER TABLE overlay_tokens ADD COLUMN token_envelope TEXT;");
    seedBaseData(sql);
    return;
  }

  createHistoricalDatabase(sql, (version - 1) as HistoricalSchemaVersion);
  switch (version) {
    case 2:
      sql.exec("ALTER TABLE overlay_tokens ADD COLUMN token_envelope TEXT;");
      break;
    case 3:
      sql.exec(`${WC_META_SCHEMA_V3_RECOVERY}${WC_CHALLENGES_SCHEMA_V3}`);
      seedChallengeData(sql);
      // Die DDL aus Migration 3 ist bereits committed; nur der Ledger-Eintrag
      // fehlt. Die aktuelle Migration 3 darf beim Wiederanlauf deshalb nicht
      // an den bereits vorhandenen Tabellen oder Spalten scheitern.
      sql.exec(`
        ALTER TABLE wc_meta ADD COLUMN surface_opacity INTEGER NOT NULL DEFAULT 100 CHECK (surface_opacity IN (0,25,50,75,100));
        ALTER TABLE wc_meta ADD COLUMN header_style TEXT NOT NULL DEFAULT 'default' CHECK (header_style IN ('default','inverted'));
        ALTER TABLE wc_meta ADD COLUMN text_emphasis TEXT NOT NULL DEFAULT 'auto' CHECK (text_emphasis IN ('auto','strong','plain'));
        ALTER TABLE wc_meta ADD COLUMN font_family TEXT NOT NULL DEFAULT 'theme' CHECK (font_family IN ('theme','atkinson','serif','sans','mono'));
        ALTER TABLE wc_meta ADD COLUMN font_scale REAL NOT NULL DEFAULT 1 CHECK (font_scale BETWEEN 0.75 AND 2);
        ALTER TABLE wc_meta ADD COLUMN penalty_label TEXT NOT NULL DEFAULT 'STRAFE';
        ALTER TABLE wc_meta ADD COLUMN penalty_text TEXT NOT NULL DEFAULT '';
        ALTER TABLE wc_meta ADD COLUMN overflow_mode TEXT NOT NULL DEFAULT 'cut' CHECK (overflow_mode IN ('cut', 'page', 'scroll'));
        ALTER TABLE wc_meta ADD COLUMN overflow_tempo TEXT NOT NULL DEFAULT 'medium' CHECK (overflow_tempo IN ('slow', 'medium', 'fast'));
        ALTER TABLE wc_meta ADD COLUMN numbered INTEGER NOT NULL DEFAULT 0 CHECK (numbered IN (0, 1));
        ALTER TABLE wc_meta ADD COLUMN done_order TEXT NOT NULL DEFAULT 'end' CHECK (done_order IN ('end', 'keep'));
        ALTER TABLE wc_meta ADD COLUMN global_timer_mode TEXT NOT NULL DEFAULT 'down' CHECK (global_timer_mode IN ('down', 'up'));
        ALTER TABLE wc_meta ADD COLUMN placement_x INTEGER NOT NULL DEFAULT 300 CHECK (placement_x BETWEEN 0 AND 384);
        ALTER TABLE wc_meta ADD COLUMN placement_y INTEGER NOT NULL DEFAULT 8 CHECK (placement_y BETWEEN 0 AND 216);
        ALTER TABLE wc_meta ADD COLUMN placement_scale REAL NOT NULL DEFAULT 1 CHECK (placement_scale BETWEEN 0.75 AND 2);
        ALTER TABLE wc_challenges ADD COLUMN timer_remain_ms INTEGER CHECK (timer_remain_ms BETWEEN 0 AND 21600000);
      `);
      break;
    case 4:
      sql.exec("ALTER TABLE wc_challenges ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));");
      break;
    case 5:
      sql.exec(`
        ALTER TABLE wc_meta ADD COLUMN placement_x INTEGER NOT NULL DEFAULT 300 CHECK (placement_x BETWEEN 0 AND 384);
        ALTER TABLE wc_meta ADD COLUMN placement_y INTEGER NOT NULL DEFAULT 8 CHECK (placement_y BETWEEN 0 AND 216);
        ALTER TABLE wc_meta ADD COLUMN placement_scale REAL NOT NULL DEFAULT 1 CHECK (placement_scale BETWEEN 0.75 AND 2);
      `);
      break;
    case 6:
      sql.exec("ALTER TABLE wc_challenges DROP COLUMN description;");
      break;
    case 7:
      sql.exec("ALTER TABLE wc_meta ADD COLUMN overflow_mode TEXT NOT NULL DEFAULT 'cut' CHECK (overflow_mode IN ('cut','page','scroll'));");
      break;
    case 8:
      sql.exec("ALTER TABLE wc_meta ADD COLUMN global_timer_mode TEXT NOT NULL DEFAULT 'down' CHECK (global_timer_mode IN ('down','up'));");
      break;
    case 9:
      sql.exec("ALTER TABLE wc_challenges ADD COLUMN timer_remain_ms INTEGER CHECK (timer_remain_ms BETWEEN 0 AND 21600000);");
      break;
    case 10:
      sql.exec("ALTER TABLE wc_meta ADD COLUMN header_style TEXT NOT NULL DEFAULT 'default' CHECK (header_style IN ('default','inverted'));");
      break;
    case 11:
      sql.exec(WC_META_SCHEMA_V11);
      break;
    case 12:
      sql.exec("ALTER TABLE wc_meta ADD COLUMN font_family TEXT NOT NULL DEFAULT 'theme' CHECK (font_family IN ('theme','atkinson','serif','sans','mono'));");
      break;
    case 13:
      sql.exec("ALTER TABLE wc_meta ADD COLUMN surface_opacity INTEGER NOT NULL DEFAULT 100 CHECK (surface_opacity IN (0,25,50,75,100));");
      break;
    case 14:
      sql.exec("ALTER TABLE wc_meta ADD COLUMN penalty_text TEXT NOT NULL DEFAULT '';");
      break;
    case 15:
      sql.exec("ALTER TABLE wc_meta ADD COLUMN penalty_label TEXT NOT NULL DEFAULT 'STRAFE';");
      break;
    case 16:
      sql.exec("ALTER TABLE wc_meta ADD COLUMN text_emphasis TEXT NOT NULL DEFAULT 'auto' CHECK (text_emphasis IN ('auto','strong','plain'));");
      break;
    default:
      throw new Error(`Unbekannte Crash-Fixture-Version: ${String(version)}`);
  }
};

const makeStub = (label: string) =>
  env.CHANNEL.get(env.CHANNEL.idFromName(`migration-harness-${label}-${crypto.randomUUID()}`));

const withHistoricalDatabase = <T>(
  version: HistoricalSchemaVersion,
  callback: (sql: SqlStorage) => T,
): Promise<T> => withHarnessDatabase(
  version,
  callback,
  (sql, initializedVersion) => {
    createHistoricalDatabase(sql, initializedVersion as HistoricalSchemaVersion);
  },
);

type LegacyChallengeSentinel = {
  id: string;
  title: string;
  target_count: number;
  timer_total_ms: number;
  sort_order: number;
  current_count: number;
  state: "pending" | "active" | "done";
  timer_ends_at: string | null;
  timer_remain_ms: number | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  hidden: number;
};

const makeSentinelInstant = (hour: number, index: number): string =>
  new Date(Date.UTC(2026, 7, 30, hour, index)).toISOString();

const makeMigration17Sentinels = (count: number = MAX_CHALLENGES): LegacyChallengeSentinel[] => Array.from(
  { length: count },
  (_, index) => ({
    id: `sentinel-id-${String(index).padStart(2, "0")}`,
    title: `sentinel-title-${String(index).padStart(2, "0")}`,
    target_count: 100 + index,
    timer_total_ms: 60_000 + index,
    sort_order: index,
    current_count: 400 + index,
    state: index % 3 === 0 ? "pending" : index % 3 === 1 ? "active" : "done",
    timer_ends_at: index % 2 === 0 ? makeSentinelInstant(12, index) : null,
    timer_remain_ms: index % 2 === 0 ? null : 1_000 + index,
    completed_at: makeSentinelInstant(13, index),
    created_at: makeSentinelInstant(14, index),
    updated_at: makeSentinelInstant(15, index),
    hidden: index % 2,
  }),
);

const insertMigration17Sentinels = (sql: SqlStorage, rows: readonly LegacyChallengeSentinel[]): void => {
  sql.exec("DELETE FROM wc_challenges");
  for (const row of rows) {
    sql.exec(
      `INSERT INTO wc_challenges(
        id, title, target_count, timer_total_ms, sort_order, current_count, state,
        timer_ends_at, timer_remain_ms, completed_at, created_at, updated_at, hidden
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.title,
      row.target_count,
      row.timer_total_ms,
      row.sort_order,
      row.current_count,
      row.state,
      row.timer_ends_at,
      row.timer_remain_ms,
      row.completed_at,
      row.created_at,
      row.updated_at,
      row.hidden,
    );
  }
};

const readLegacyChallengeSentinels = (sql: SqlStorage): LegacyChallengeSentinel[] => sql
  .exec<LegacyChallengeSentinel>(
    `SELECT id, title, target_count, timer_total_ms, sort_order, current_count, state,
      timer_ends_at, timer_remain_ms, completed_at, created_at, updated_at, hidden
     FROM wc_challenges ORDER BY id`,
  )
  .toArray();

describe("Migrations-Harness", () => {
  it("haelt den vollstaendig synchronen Migrationspfad fest", () => {
    const forbiddenConstructs = [
      ["await", /\bawait\b/],
      ["async", /\basync\b/],
      ["Promise", /\bPromise\b/],
    ] as const;
    const violations = [MIGRATIONS_SOURCE, CONTROL_KEYS_SOURCE]
      .flatMap((source) => forbiddenConstructs
        .filter(([, pattern]) => pattern.test(source))
        .map(([construct]) => construct));

    expect(
      violations,
      "runMigrations und alle von ihm aufgerufenen Migrationen muessen synchron bleiben",
    ).toEqual([]);
  });

  it("führt eine frische Datenbank durch die Versionen 1 bis 17", async () => {
    const result = await withHistoricalDatabase(0, (sql) => {
      runMigrations(sql, "migration-harness-fresh");
      return {
        schema: readSchemaSnapshot(sql),
        versions: sql
          .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations ORDER BY version")
          .toArray()
          .map(({ version }) => version),
        meta: sql
          .exec<{
            style_id: string;
            surface_opacity: number;
            header_style: string;
            text_emphasis: string;
            font_family: string;
            font_scale: number;
            penalty_label: string;
            penalty_text: string;
            max_visible: number;
          }>("SELECT style_id, surface_opacity, header_style, text_emphasis, font_family, font_scale, penalty_label, penalty_text, max_visible FROM wc_meta WHERE singleton = 1")
          .toArray()[0],
      };
    });

    expect(result.versions).toEqual(CURRENT_VERSIONS);
    expect(result.schema.filter(({ type }) => type === "table").map(({ name }) => name)).toEqual([
      "_sql_schema_migrations",
      "audit_log",
      "channel_state",
      "csrf_tokens",
      "editor_sessions",
      "media_blobs",
      "media_leases",
      "oauth_nonces",
      "overlay_tokens",
      "state_history",
      "twitch_user_cache",
      "wc_challenges",
      "wc_commands",
      "wc_dock_tokens",
      "wc_meta",
      "wc_retired_keys",
    ]);
    expect(result.schema.find(({ name }) => name === "wc_meta")?.sql).toMatch(/surface_opacity/i);
    expect(result.schema.find(({ name }) => name === "wc_meta")?.sql).not.toMatch(/surface_mode/i);
    expect(result.meta).toEqual({
      style_id: "plain-list",
      surface_opacity: 100,
      header_style: "default",
      text_emphasis: "auto",
      font_family: "theme",
      font_scale: 1,
      penalty_label: "STRAFE",
      penalty_text: "",
      max_visible: 5,
    });
  });

  it.each(HISTORICAL_VERSIONS)("überführt eine Datenbank auf Stand %i ohne Nutzdatenverlust", async (version) => {
    const result = await withHistoricalDatabase(version, (sql) => {
      runMigrations(sql, `migration-harness-upgrade-v${String(version)}`);
      return {
        channelState: sql
          .exec<{
            singleton: number;
            revision: number;
            overlay_enabled: number;
            state_json: string;
            updated_at: string;
            updated_by_id: string;
            updated_by_name: string;
          }>("SELECT singleton, revision, overlay_enabled, state_json, updated_at, updated_by_id, updated_by_name FROM channel_state WHERE singleton = 1")
          .toArray()[0],
        stateHistory: sql
          .exec<{ revision: number; snapshot_json: string; created_at: string; summary: string }>(
            "SELECT revision, snapshot_json, created_at, summary FROM state_history WHERE revision = 7",
          )
          .toArray()[0],
        auditLog: sql
          .exec<{
            id: string;
            revision: number;
            action: string;
            actor_id: string;
            actor_name: string;
            summary: string;
            created_at: string;
          }>("SELECT id, revision, action, actor_id, actor_name, summary, created_at FROM audit_log ORDER BY id")
          .toArray(),
        challenges: sql
          .exec<{
            id: string;
            title: string;
            target_count: number | null;
            timer_total_ms: number | null;
            sort_order: number;
            kind: string;
            unit: string | null;
            control_key: string;
            step: number;
            best_count: number;
            current_count: number;
            state: string;
            timer_ends_at: string | null;
            timer_remain_ms: number | null;
            completed_at: string | null;
            created_at: string;
            updated_at: string;
            hidden: number;
          }>(
            "SELECT id, title, target_count, timer_total_ms, sort_order, kind, unit, control_key, step, best_count, current_count, state, timer_ends_at, timer_remain_ms, completed_at, created_at, updated_at, hidden FROM wc_challenges ORDER BY id",
          )
          .toArray(),
        meta: sql
          .exec<{
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
            penalty_label: string;
            penalty_text: string;
            effects_enabled: number;
            max_visible: number;
            overflow_mode: string;
            overflow_tempo: string;
            numbered: number;
            done_order: string;
            global_timer_mode: string;
            placement_x: number;
            placement_y: number;
            placement_scale: number;
            global_timer_total_ms: number | null;
            global_timer_ends_at: string | null;
            global_timer_paused_remain_ms: number | null;
          }>(
            "SELECT singleton, event_seq, board_revision, settings_revision, style_id, theme_mode, surface_opacity, header_style, text_emphasis, font_family, font_scale, header_title, penalty_label, penalty_text, effects_enabled, max_visible, overflow_mode, overflow_tempo, numbered, done_order, global_timer_mode, placement_x, placement_y, placement_scale, global_timer_total_ms, global_timer_ends_at, global_timer_paused_remain_ms FROM wc_meta WHERE singleton = 1",
          )
          .toArray()[0],
        commands: sql
          .exec<{ command_id: string; request_hash: string; created_at: string }>(
            "SELECT command_id, request_hash, created_at FROM wc_commands ORDER BY command_id",
          )
          .toArray(),
        dockTokens: sql
          .exec<{
            singleton: number;
            token_hash: string;
            token_envelope: string | null;
            fingerprint: string;
            generation: number;
            request_id: string;
            creating_session_hash: string;
            created_at: string;
            last_used_at: string | null;
          }>(
            "SELECT singleton, token_hash, token_envelope, fingerprint, generation, request_id, creating_session_hash, created_at, last_used_at FROM wc_dock_tokens WHERE singleton = 1",
          )
          .toArray(),
        versions: sql
          .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations ORDER BY version")
          .toArray()
          .map(({ version: appliedVersion }) => appliedVersion),
        schema: readSchemaSnapshot(sql),
      };
    });

    expect(result.channelState).toEqual({
      singleton: 1,
      revision: 7,
      overlay_enabled: 1,
      state_json: '{"fixture":true}',
      updated_at: FIXTURE_TIMESTAMP,
      updated_by_id: "fixture-user",
      updated_by_name: "Fixture",
    });
    expect(result.stateHistory).toEqual({
      revision: 7,
      snapshot_json: '{"fixture":true}',
      created_at: FIXTURE_TIMESTAMP,
      summary: "Fixture-Zustand",
    });
    expect(result.auditLog).toEqual([
      {
        id: "fixture-audit",
        revision: 7,
        action: "fixture",
        actor_id: "fixture-user",
        actor_name: "Fixture",
        summary: "Fixture-Eintrag",
        created_at: FIXTURE_TIMESTAMP,
      },
    ]);
    if (version >= 3) {
      expect(result.challenges).toMatchObject([
        {
          id: "fixture-active",
          title: "Aktive Challenge",
          target_count: 5,
          timer_total_ms: 90000,
          sort_order: 2,
          kind: "counter",
          unit: null,
          step: 1,
          best_count: 2,
          current_count: 2,
          state: "active",
          timer_ends_at: "2026-08-30T12:45:00.000Z",
          timer_remain_ms: null,
          completed_at: null,
          created_at: FIXTURE_TIMESTAMP,
          updated_at: FIXTURE_TIMESTAMP,
          hidden: 0,
        },
        {
          id: "fixture-done",
          title: "Erledigte Challenge",
          target_count: 3,
          timer_total_ms: 60000,
          sort_order: 1,
          kind: "counter",
          unit: null,
          step: 1,
          best_count: 3,
          current_count: 3,
          state: "done",
          timer_ends_at: null,
          timer_remain_ms: null,
          completed_at: "2026-08-30T12:31:00.000Z",
          created_at: FIXTURE_TIMESTAMP,
          updated_at: FIXTURE_TIMESTAMP,
          hidden: 0,
        },
      ]);
      expect(result.meta).toEqual({
        singleton: 1,
        event_seq: 42,
        board_revision: 7,
        settings_revision: 8,
        style_id: "plain-list",
        theme_mode: "inherit",
        surface_opacity: 0,
        header_style: "default",
        text_emphasis: "auto",
        font_family: "theme",
        font_scale: 1,
        header_title: "Historisches Board",
        penalty_label: "STRAFE",
        penalty_text: "",
        effects_enabled: 0,
        max_visible: 10,
        overflow_mode: "cut",
        overflow_tempo: "medium",
        numbered: 1,
        done_order: "end",
        global_timer_mode: "down",
        placement_x: 300,
        placement_y: 8,
        placement_scale: 1,
        global_timer_total_ms: 120000,
        global_timer_ends_at: null,
        global_timer_paused_remain_ms: null,
      });
      expect(result.commands).toEqual([
        { command_id: "fixture-command", request_hash: "fixture-request-hash", created_at: FIXTURE_TIMESTAMP },
      ]);
      expect(result.dockTokens).toEqual([
        {
          singleton: 1,
          token_hash: "fixture-token-hash",
          token_envelope: "fixture-token-envelope",
          fingerprint: "fixture-fingerprint",
          generation: 3,
          request_id: "fixture-request",
          creating_session_hash: "fixture-session",
          created_at: FIXTURE_TIMESTAMP,
          last_used_at: null,
        },
      ]);
    } else {
      expect(result.challenges).toEqual([]);
      expect(result.meta).toEqual({
        singleton: 1,
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
        done_order: "end",
        global_timer_mode: "down",
        placement_x: 300,
        placement_y: 8,
        placement_scale: 1,
        global_timer_total_ms: null,
        global_timer_ends_at: null,
        global_timer_paused_remain_ms: null,
      });
      expect(result.commands).toEqual([]);
      expect(result.dockTokens).toEqual([]);
    }
    expect(result.versions).toEqual(CURRENT_VERSIONS);
    expect(result.schema.some(({ name }) => name === "wc_meta_migration_11")).toBe(false);
    expect(result.schema.find(({ name }) => name === "wc_challenges")?.sql).not.toMatch(/\bdescription\b/i);
  });

  it("führt Migration 17 für Bestandsdaten mit eindeutigen Keys und symmetrischer Überzeit-Grenze aus", async () => {
    const result = await withHistoricalDatabase(16, (sql) => {
      runMigrations(sql, "migration-harness-v17");
      return {
        challenges: sql
          .exec<{
            id: string;
            kind: string;
            unit: string | null;
            control_key: string;
            step: number;
            best_count: number;
            current_count: number;
            timer_remain_ms: number | null;
          }>("SELECT id, kind, unit, control_key, step, best_count, current_count, timer_remain_ms FROM wc_challenges ORDER BY id")
          .toArray(),
        retiredKeys: sql
          .exec<{ control_key: string }>("SELECT control_key FROM wc_retired_keys")
          .toArray(),
        challengeSchema: sql
          .exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wc_challenges'")
          .toArray()[0]?.sql,
        metaSchema: sql
          .exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wc_meta'")
          .toArray()[0]?.sql,
      };
    });

    expect(result.challenges).toMatchObject([
      {
        id: "fixture-active",
        kind: "counter",
        unit: null,
        step: 1,
        best_count: 2,
        current_count: 2,
        timer_remain_ms: null,
      },
      {
        id: "fixture-done",
        kind: "counter",
        unit: null,
        step: 1,
        best_count: 3,
        current_count: 3,
        timer_remain_ms: null,
      },
    ]);
    expect(result.challenges.every(({ control_key }) => /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(control_key))).toBe(true);
    expect(new Set(result.challenges.map(({ control_key }) => control_key.toUpperCase())).size).toBe(2);
    expect(result.retiredKeys).toEqual([]);
    expect(result.challengeSchema).toMatch(/kind\s+TEXT\s+NOT NULL/i);
    expect(result.challengeSchema).toMatch(/unit\s+TEXT/i);
    expect(result.challengeSchema).toMatch(/control_key\s+TEXT\s+NOT NULL/i);
    expect(result.challengeSchema).toMatch(/timer_remain_ms\s+INTEGER[^,]*BETWEEN\s+-21600000\s+AND\s+21600000/i);
    expect(result.challengeSchema).toMatch(/step\s+INTEGER\s+NOT NULL[^,]*CHECK\s*\(\s*step\s*>=\s*1\s*\)/i);
    expect(result.metaSchema).toMatch(/global_timer_paused_remain_ms\s+INTEGER/i);
    expect(result.metaSchema).not.toMatch(/global_timer_paused_remain_ms\s+IS\s+NULL\s+OR\s+global_timer_paused_remain_ms\s*>=\s*0/i);
  });

  it.each([
    ["historischen V16-Fixture", (sql: SqlStorage) => { createHistoricalDatabase(sql, 16); }],
    ["heutigen MIGRATION_3-V16-Fixture", createCurrentMigration3V16Database],
  ] as const)("überführt 30 Zeilen vollständig aus dem %s", async (_label, initialize) => {
    const result = await withHarnessDatabase(16, (sql) => {
      const sentinels = makeMigration17Sentinels();
      insertMigration17Sentinels(sql, sentinels);
      const before = readLegacyChallengeSentinels(sql);

      runMigrations(sql, "migration-harness-v17-sentinels");

      return {
        before,
        after: readLegacyChallengeSentinels(sql),
        challenges: sql
          .exec<{
            id: string;
            title: string;
            kind: string;
            unit: string | null;
            control_key: string;
            target_count: number | null;
            timer_total_ms: number | null;
            sort_order: number;
            step: number;
            best_count: number;
            current_count: number;
          }>(
            `SELECT id, title, kind, unit, control_key, target_count, timer_total_ms,
              sort_order, step, best_count, current_count
             FROM wc_challenges ORDER BY rowid`,
          )
          .toArray(),
        version17: sql
          .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations WHERE version = 17")
          .toArray(),
      };
    }, initialize);

    expect(result.before).toHaveLength(30);
    expect(result.after).toHaveLength(30);
    expect(result.after).toEqual(result.before);
    expect(result.challenges).toHaveLength(MAX_CHALLENGES);
    expect(result.challenges.map(({ id }) => id)).toEqual(result.before.map(({ id }) => id));
    expect(result.challenges.map(({ title }) => title)).toEqual(result.before.map(({ title }) => title));
    expect(result.challenges.every(({ kind, unit, step }) => kind === "counter" && unit === null && step === 1)).toBe(true);
    expect(result.challenges.map(({ target_count }) => target_count)).toEqual(result.before.map(({ target_count }) => target_count));
    expect(result.challenges.map(({ timer_total_ms }) => timer_total_ms)).toEqual(result.before.map(({ timer_total_ms }) => timer_total_ms));
    expect(result.challenges.map(({ sort_order }) => sort_order)).toEqual(result.before.map(({ sort_order }) => sort_order));
    expect(result.challenges.map(({ current_count, best_count }) => [current_count, best_count])).toEqual(
      result.before.map(({ current_count }) => [current_count, current_count]),
    );
    expect(new Set(result.challenges.map(({ control_key }) => control_key.toLowerCase())).size)
      .toBe(MAX_CHALLENGES);
    expect(result.version17).toEqual([{ version: 17 }]);
  });

  it("führt den Migration-17-Backfill auch für 120 Altzeilen ohne variable Bindingzahl aus", async () => {
    const sentinels = makeMigration17Sentinels(120);
    const result = await withHistoricalDatabase(16, (sql) => {
      insertMigration17Sentinels(sql, sentinels);
      runMigrations(sql, "migration-harness-v17-binding-limit");
      return {
        ids: sql.exec<{ id: string }>("SELECT id FROM wc_challenges ORDER BY id").toArray(),
        keys: sql.exec<{ control_key: string }>("SELECT control_key FROM wc_challenges ORDER BY id").toArray(),
        temporaryTables: sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_migration_17'")
          .toArray(),
        version17: sql
          .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations WHERE version = 17")
          .toArray(),
      };
    });

    expect(result.ids).toEqual(sentinels.map(({ id }) => ({ id })).sort((left, right) => left.id.localeCompare(right.id)));
    expect(result.keys).toHaveLength(120);
    expect(new Set(result.keys.map(({ control_key }) => control_key.toLowerCase())).size).toBe(120);
    expect(result.temporaryTables).toEqual([]);
    expect(result.version17).toEqual([{ version: 17 }]);
  });

  /*
   * Dieser Test beweist den operativ relevanten Wiederanlauf nach einem
   * abgefangenen Fehler: Nutzdaten kommen vollständig an, die Temp-Tabelle
   * verschwindet und der Ledger wird genau einmal geschrieben. Die
   * Rollback-Semantik eines abgefangenen Fehlers wird hier ausdrücklich nicht
   * entschieden; deshalb ist Migration 17 aufräumend gebaut.
   */
  it("räumt nach einem Abbruch auf und lässt den vollständigen Wiederanlauf zu", async () => {
    await withHistoricalDatabase(16, (sql) => {
      sql.exec("PRAGMA foreign_keys = ON");
      sql.exec(`
        CREATE TABLE migration_17_drop_blocker (
          challenge_id TEXT PRIMARY KEY REFERENCES wc_challenges(id)
        );
      `);
      sql.exec("INSERT INTO migration_17_drop_blocker(challenge_id) VALUES ('fixture-active')");

      expect(() => { runMigrations(sql, "migration-harness-v17-rollback"); }).toThrow();

      sql.exec("PRAGMA foreign_keys = OFF");
      sql.exec("DROP TABLE migration_17_drop_blocker");
      runMigrations(sql, "migration-harness-v17-retry");

      expect(readLegacyChallengeSentinels(sql)).toEqual([
        {
          id: "fixture-active",
          title: "Aktive Challenge",
          target_count: 5,
          timer_total_ms: 90000,
          sort_order: 2,
          current_count: 2,
          state: "active",
          timer_ends_at: "2026-08-30T12:45:00.000Z",
          timer_remain_ms: null,
          completed_at: null,
          created_at: FIXTURE_TIMESTAMP,
          updated_at: FIXTURE_TIMESTAMP,
          hidden: 0,
        },
        {
          id: "fixture-done",
          title: "Erledigte Challenge",
          target_count: 3,
          timer_total_ms: 60000,
          sort_order: 1,
          current_count: 3,
          state: "done",
          timer_ends_at: null,
          timer_remain_ms: null,
          completed_at: "2026-08-30T12:31:00.000Z",
          created_at: FIXTURE_TIMESTAMP,
          updated_at: FIXTURE_TIMESTAMP,
          hidden: 0,
        },
      ]);
      expect(
        sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_migration_17'")
          .toArray(),
      ).toEqual([]);
      expect(
        sql.exec<{ version: number }>("SELECT version FROM _sql_schema_migrations WHERE version = 17").toArray(),
      ).toEqual([{ version: 17 }]);
    });
  });

  it.each(ALL_SCHEMA_VERSIONS)("macht einen zweiten Lauf auf Stand %i zu einem echten No-op", async (version) => {
    await withHistoricalDatabase(version, (sql) => {
      runMigrations(sql, `migration-harness-idempotency-v${String(version)}`);
      const before = readDatabaseSnapshot(sql);
      runMigrations(sql, `migration-harness-idempotency-second-v${String(version)}`);
      expectDatabaseSnapshot(sql, before);
    });
  });

  it.each(RECOVERABLE_CRASH_VERSIONS)("nimmt einen Abbruch nach einem Guard-Schritt für Version %i wieder auf", async (version) => {
    const stub = makeStub(`crash-v${String(version)}`);
    await runInDurableObject(stub, (_instance, state) => {
      createRecoverableCrashFixture(state.storage.sql, version);
      expect(() => {
        runMigrations(state.storage.sql, `migration-harness-recover-v${String(version)}`);
      }).not.toThrow();
      expect(
        state.storage.sql
          .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations WHERE version = ?", version)
          .toArray(),
      ).toHaveLength(1);
    });
  });

});
