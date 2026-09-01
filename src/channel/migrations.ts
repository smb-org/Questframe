const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
  version INTEGER PRIMARY KEY,
  build_id TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL,
  overlay_enabled INTEGER NOT NULL CHECK (overlay_enabled IN (0, 1)),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_id TEXT NOT NULL,
  updated_by_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS state_history (
  revision INTEGER PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS editor_sessions (
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
CREATE TABLE IF NOT EXISTS csrf_tokens (
  session_hash TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  previous_token_hash TEXT,
  previous_expires_at TEXT,
  PRIMARY KEY (session_hash, tab_id)
);
CREATE TABLE IF NOT EXISTS oauth_nonces (
  nonce_hash TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  pkce_verifier TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS overlay_tokens (
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
CREATE TABLE IF NOT EXISTS media_blobs (
  content_hash TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media_leases (
  content_hash TEXT NOT NULL,
  editor_session_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (content_hash, editor_session_hash)
);
CREATE TABLE IF NOT EXISTS twitch_user_cache (
  twitch_user_id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  portrait_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS history_created_idx ON state_history(created_at DESC);
`;

const MIGRATION_2 = `
ALTER TABLE overlay_tokens ADD COLUMN token_envelope TEXT;
`;

const MIGRATION_3 = `
CREATE TABLE IF NOT EXISTS wc_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  event_seq INTEGER NOT NULL,
  board_revision INTEGER NOT NULL,
  settings_revision INTEGER NOT NULL,
  style_id TEXT NOT NULL,
  theme_mode TEXT NOT NULL CHECK (theme_mode IN ('inherit', 'own')),
  surface_mode TEXT NOT NULL CHECK (surface_mode IN ('surface', 'bare')),
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
CREATE TABLE IF NOT EXISTS wc_challenges (
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
CREATE TABLE IF NOT EXISTS wc_commands (
  command_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wc_dock_tokens (
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
  theme_mode, surface_mode, header_title, effects_enabled,
  max_visible,
  overflow_mode, overflow_tempo, numbered, done_order,
  global_timer_mode,
  placement_x, placement_y, placement_scale,
  global_timer_total_ms, global_timer_ends_at, global_timer_paused_remain_ms
) VALUES (1, 0, 1, 1, 'plain-list', 'inherit', 'surface', 'CHALLENGES', 1,
  5, 'cut', 'medium', 0, 'end', 'down', 300, 8, 1, NULL, NULL, NULL)
ON CONFLICT(singleton) DO NOTHING;
`;

const hasOverlayTokenEnvelope = (sql: SqlStorage): boolean =>
  sql
    .exec<{ name: string }>("PRAGMA table_info(overlay_tokens)")
    .toArray()
    .some((column) => column.name === "token_envelope");

const MIGRATION_4 = `
ALTER TABLE wc_challenges ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));
`;

const hasChallengeHidden = (sql: SqlStorage): boolean =>
  sql
    .exec<{ name: string }>("PRAGMA table_info(wc_challenges)")
    .toArray()
    .some((column) => column.name === "hidden");

const MIGRATION_5 = `
ALTER TABLE wc_meta ADD COLUMN placement_x INTEGER NOT NULL DEFAULT 300 CHECK (placement_x BETWEEN 0 AND 384);
ALTER TABLE wc_meta ADD COLUMN placement_y INTEGER NOT NULL DEFAULT 8 CHECK (placement_y BETWEEN 0 AND 216);
ALTER TABLE wc_meta ADD COLUMN placement_scale REAL NOT NULL DEFAULT 1 CHECK (placement_scale BETWEEN 0.75 AND 2);
`;

const hasChallengePlacement = (sql: SqlStorage): boolean =>
  sql
    .exec<{ name: string }>("PRAGMA table_info(wc_meta)")
    .toArray()
    .some((column) => column.name === "placement_x");

const MIGRATION_6 = `
ALTER TABLE wc_challenges DROP COLUMN description;
`;

const hasChallengeDescription = (sql: SqlStorage): boolean =>
  sql
    .exec<{ name: string }>("PRAGMA table_info(wc_challenges)")
    .toArray()
    .some((column) => column.name === "description");

const hasChallengeMetaColumn = (sql: SqlStorage, name: string): boolean =>
  sql
    .exec<{ name: string }>("PRAGMA table_info(wc_meta)")
    .toArray()
    .some((column) => column.name === name);

const MIGRATION_7_OVERFLOW_MODE = `
ALTER TABLE wc_meta ADD COLUMN overflow_mode TEXT NOT NULL DEFAULT 'cut' CHECK (overflow_mode IN ('cut','page','scroll'));
`;
const MIGRATION_7_OVERFLOW_TEMPO = `
ALTER TABLE wc_meta ADD COLUMN overflow_tempo TEXT NOT NULL DEFAULT 'medium' CHECK (overflow_tempo IN ('slow','medium','fast'));
`;
const MIGRATION_7_NUMBERED = `
ALTER TABLE wc_meta ADD COLUMN numbered INTEGER NOT NULL DEFAULT 0 CHECK (numbered IN (0,1));
`;
const MIGRATION_7_DONE_ORDER = `
ALTER TABLE wc_meta ADD COLUMN done_order TEXT NOT NULL DEFAULT 'end' CHECK (done_order IN ('end','keep'));
`;

const MIGRATION_8_GLOBAL_TIMER_MODE = `
ALTER TABLE wc_meta ADD COLUMN global_timer_mode TEXT NOT NULL DEFAULT 'down' CHECK (global_timer_mode IN ('down','up'));
`;

const MIGRATION_9_CHALLENGE_TIMER_REMAIN = `
ALTER TABLE wc_challenges ADD COLUMN timer_remain_ms INTEGER CHECK (timer_remain_ms BETWEEN 0 AND 21600000);
`;

const hasChallengeTimerRemain = (sql: SqlStorage): boolean =>
  sql
    .exec<{ name: string }>("PRAGMA table_info(wc_challenges)")
    .toArray()
    .some((column) => column.name === "timer_remain_ms");

export const runMigrations = (sql: SqlStorage, buildId = "dev"): void => {
  sql.exec(MIGRATION_1);
  const versionOneWasApplied = sql
    .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations WHERE version = 1")
    .toArray().length > 0;
  if (!versionOneWasApplied) {
    sql.exec(
      "INSERT INTO _sql_schema_migrations(version, build_id, applied_at) VALUES (?, ?, ?)",
      1,
      buildId,
      new Date().toISOString(),
    );
  }
  const versionTwoWasApplied = sql
    .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations WHERE version = 2")
    .toArray().length > 0;
  if (!versionTwoWasApplied) {
    // Frische Datenbanken bekommen die Spalte schon aus MIGRATION_1. Der ALTER
    // laeuft deshalb nur, wenn sie wirklich fehlt: SQLite kennt kein
    // IF NOT EXISTS, und ein Abbruch zwischen ALTER und Versionseintrag wuerde
    // den Kanal sonst bei jedem Start an "duplicate column name" aufhaengen.
    if (!hasOverlayTokenEnvelope(sql)) sql.exec(MIGRATION_2);
    sql.exec(
      "INSERT INTO _sql_schema_migrations(version, build_id, applied_at) VALUES (?, ?, ?)",
      2,
      buildId,
      new Date().toISOString(),
    );
  }
  const versionThreeWasApplied = sql
    .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations WHERE version = 3")
    .toArray().length > 0;
  if (!versionThreeWasApplied) {
    sql.exec(MIGRATION_3);
    sql.exec(
      "INSERT INTO _sql_schema_migrations(version, build_id, applied_at) VALUES (?, ?, ?)",
      3,
      buildId,
      new Date().toISOString(),
    );
  }
  const versionFourWasApplied = sql
    .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations WHERE version = 4")
    .toArray().length > 0;
  if (!versionFourWasApplied) {
    if (!hasChallengeHidden(sql)) sql.exec(MIGRATION_4);
    sql.exec("UPDATE wc_challenges SET timer_ends_at = NULL WHERE state = 'done' AND timer_ends_at IS NOT NULL");
    sql.exec(
      "INSERT INTO _sql_schema_migrations(version, build_id, applied_at) VALUES (?, ?, ?)",
      4,
      buildId,
      new Date().toISOString(),
    );
  }
  const versionFiveWasApplied = sql
    .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations WHERE version = 5")
    .toArray().length > 0;
  if (!versionFiveWasApplied) {
    if (!hasChallengePlacement(sql)) sql.exec(MIGRATION_5);
    sql.exec(
      "INSERT INTO _sql_schema_migrations(version, build_id, applied_at) VALUES (?, ?, ?)",
      5,
      buildId,
      new Date().toISOString(),
    );
  }
  const versionSixWasApplied = sql
    .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations WHERE version = 6")
    .toArray().length > 0;
  if (!versionSixWasApplied) {
    if (hasChallengeDescription(sql)) sql.exec(MIGRATION_6);
    sql.exec(
      "INSERT INTO _sql_schema_migrations(version, build_id, applied_at) VALUES (?, ?, ?)",
      6,
      buildId,
      new Date().toISOString(),
    );
  }
  const versionSevenWasApplied = sql
    .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations WHERE version = 7")
    .toArray().length > 0;
  if (!versionSevenWasApplied) {
    if (!hasChallengeMetaColumn(sql, "overflow_mode")) sql.exec(MIGRATION_7_OVERFLOW_MODE);
    if (!hasChallengeMetaColumn(sql, "overflow_tempo")) sql.exec(MIGRATION_7_OVERFLOW_TEMPO);
    if (!hasChallengeMetaColumn(sql, "numbered")) sql.exec(MIGRATION_7_NUMBERED);
    if (!hasChallengeMetaColumn(sql, "done_order")) sql.exec(MIGRATION_7_DONE_ORDER);
    sql.exec("UPDATE wc_meta SET style_id = 'plain-list', numbered = 1 WHERE style_id = 'plain-numbered'");
    sql.exec(
      "INSERT INTO _sql_schema_migrations(version, build_id, applied_at) VALUES (?, ?, ?)",
      7,
      buildId,
      new Date().toISOString(),
    );
  }
  const versionEightWasApplied = sql
    .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations WHERE version = 8")
    .toArray().length > 0;
  if (!versionEightWasApplied) {
    if (!hasChallengeMetaColumn(sql, "global_timer_mode")) sql.exec(MIGRATION_8_GLOBAL_TIMER_MODE);
    sql.exec(
      "INSERT INTO _sql_schema_migrations(version, build_id, applied_at) VALUES (?, ?, ?)",
      8,
      buildId,
      new Date().toISOString(),
    );
  }
  const versionNineWasApplied = sql
    .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations WHERE version = 9")
    .toArray().length > 0;
  if (!versionNineWasApplied) {
    if (!hasChallengeTimerRemain(sql)) sql.exec(MIGRATION_9_CHALLENGE_TIMER_REMAIN);
    sql.exec(
      "INSERT INTO _sql_schema_migrations(version, build_id, applied_at) VALUES (?, ?, ?)",
      9,
      buildId,
      new Date().toISOString(),
    );
  }
};
