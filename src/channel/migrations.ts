import { allocateControlKey } from "../modules/win-challenges/domain/control-keys";

type Migration = {
  version: number;
  /** Optionaler Idempotenz-Wächter. Liefert true, wenn der Migrationseintrag bereits angewendet ist. */
  guard?: (sql: SqlStorage) => boolean;
} & (
  | { statements: readonly string[]; run?: never }
  | { run: (sql: SqlStorage) => void; statements?: never }
);

const splitSqlStatements = (sql: string): readonly string[] => {
  const statements: string[] = [];
  let statementStart = 0;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote !== null) {
      if (character === quote) {
        if (sql[index + 1] === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === ";") {
      const statement = sql.slice(statementStart, index).trim();
      if (statement.length > 0) statements.push(statement);
      statementStart = index + 1;
    }
  }

  const lastStatement = sql.slice(statementStart).trim();
  if (lastStatement.length > 0) statements.push(lastStatement);
  return statements;
};

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
  theme_mode, surface_opacity, header_style, text_emphasis, header_title, penalty_label, penalty_text, effects_enabled,
  max_visible,
  overflow_mode, overflow_tempo, numbered, done_order,
  global_timer_mode,
  placement_x, placement_y, placement_scale,
  global_timer_total_ms, global_timer_ends_at, global_timer_paused_remain_ms
) VALUES (1, 0, 1, 1, 'plain-list', 'inherit', 100, 'default', 'auto', 'CHALLENGES', 'STRAFE', '', 1,
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

const MIGRATION_10_HEADER_STYLE = "ALTER TABLE wc_meta ADD COLUMN header_style TEXT NOT NULL DEFAULT 'default' CHECK (header_style IN ('default','inverted'));";

const MIGRATION_12_FONT_FAMILY = "ALTER TABLE wc_meta ADD COLUMN font_family TEXT NOT NULL DEFAULT 'theme' CHECK (font_family IN ('theme','atkinson','serif','sans','mono'));";
const MIGRATION_12_FONT_SCALE = "ALTER TABLE wc_meta ADD COLUMN font_scale REAL NOT NULL DEFAULT 1 CHECK (font_scale BETWEEN 0.75 AND 2);";

const MIGRATION_13_SURFACE_OPACITY_ADD = "ALTER TABLE wc_meta ADD COLUMN surface_opacity INTEGER NOT NULL DEFAULT 100 CHECK (surface_opacity IN (0,25,50,75,100));";
const MIGRATION_13_SURFACE_OPACITY_BACKFILL = "UPDATE wc_meta SET surface_opacity = CASE surface_mode WHEN 'bare' THEN 0 ELSE 100 END;";
const MIGRATION_13_SURFACE_MODE_DROP = "ALTER TABLE wc_meta DROP COLUMN surface_mode;";

const createChallengeMetaRebuildMigration = (surfaceOpacityExpression: string): string => `
CREATE TABLE wc_meta_migration_11 (
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
INSERT INTO wc_meta_migration_11(
  singleton, event_seq, board_revision, settings_revision, style_id,
  theme_mode, surface_opacity, header_style, text_emphasis, header_title, effects_enabled,
  max_visible, overflow_mode, overflow_tempo, numbered, done_order,
  global_timer_mode, placement_x, placement_y, placement_scale,
  global_timer_total_ms, global_timer_ends_at, global_timer_paused_remain_ms
)
SELECT
  singleton, event_seq, board_revision, settings_revision, style_id,
  theme_mode, ${surfaceOpacityExpression}, header_style, 'auto', header_title, effects_enabled,
  max_visible, overflow_mode, overflow_tempo, numbered, done_order,
  global_timer_mode, placement_x, placement_y, placement_scale,
  global_timer_total_ms, global_timer_ends_at, global_timer_paused_remain_ms
FROM wc_meta;
DROP TABLE wc_meta;
ALTER TABLE wc_meta_migration_11 RENAME TO wc_meta;
`;

const MIGRATION_11_WC_META_REBUILD = createChallengeMetaRebuildMigration("surface_opacity");
const MIGRATION_11_WC_META_REBUILD_LEGACY_SURFACE_MODE = createChallengeMetaRebuildMigration(
  "CASE surface_mode WHEN 'bare' THEN 0 ELSE 100 END",
);

const hasMaxVisibleRowsCheck = (sql: SqlStorage): boolean => {
  const tableSql = sql
    .exec<{ sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wc_meta'",
    )
    .toArray()[0]?.sql;
  return tableSql !== null && tableSql !== undefined && /max_visible\s+between\s+3\s+and\s+20/i.test(tableSql);
};

const hasChallengeTimerRemain = (sql: SqlStorage): boolean =>
  sql
    .exec<{ name: string }>("PRAGMA table_info(wc_challenges)")
    .toArray()
    .some((column) => column.name === "timer_remain_ms");

const MIGRATION_14_PENALTY_TEXT = "ALTER TABLE wc_meta ADD COLUMN penalty_text TEXT NOT NULL DEFAULT '';";
const MIGRATION_15_PENALTY_LABEL = "ALTER TABLE wc_meta ADD COLUMN penalty_label TEXT NOT NULL DEFAULT 'STRAFE';";
const MIGRATION_16_TEXT_EMPHASIS = "ALTER TABLE wc_meta ADD COLUMN text_emphasis TEXT NOT NULL DEFAULT 'auto' CHECK (text_emphasis IN ('auto','strong','plain'));";
const MIGRATION_18_KEY_VISIBLE = "ALTER TABLE wc_meta ADD COLUMN key_visible INTEGER NOT NULL DEFAULT 0 CHECK (key_visible IN (0,1));";

const MIGRATION_19_SETS = `
CREATE TABLE IF NOT EXISTS wc_sets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('user', 'autosave')),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  has_progress INTEGER NOT NULL CHECK (has_progress IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS wc_sets_user_name_idx
  ON wc_sets(normalized_name) WHERE type = 'user';
CREATE INDEX IF NOT EXISTS wc_sets_updated_idx ON wc_sets(updated_at DESC);
`;

const MIGRATION_20_THEME_MODE = "UPDATE wc_meta SET theme_mode = 'own';";

const hasChallengeSetsTable = (sql: SqlStorage): boolean =>
  sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wc_sets'",
    )
    .toArray()
    .length > 0;

type Migration17ChallengeRow = {
  id: string;
  title: string;
  target_count: number | null;
  timer_total_ms: number | null;
  sort_order: number;
  hidden: number;
  current_count: number;
  state: string;
  timer_ends_at: string | null;
  timer_remain_ms: number | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

const MIGRATION_17_CREATE_CHALLENGES_TABLE = `
CREATE TABLE wc_challenges_migration_17 (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tick', 'counter', 'streak', 'measure')),
  unit TEXT,
  control_key TEXT NOT NULL COLLATE NOCASE UNIQUE,
  target_count INTEGER,
  timer_total_ms INTEGER,
  sort_order INTEGER NOT NULL,
  step INTEGER NOT NULL DEFAULT 1 CHECK (step >= 1),
  best_count INTEGER NOT NULL,
  hidden INTEGER NOT NULL CHECK (hidden IN (0, 1)),
  current_count INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'done')),
  timer_ends_at TEXT,
  timer_remain_ms INTEGER CHECK (timer_remain_ms BETWEEN -21600000 AND 21600000),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind = 'measure' AND unit IS NOT NULL)
    OR (kind <> 'measure' AND unit IS NULL)
  ),
  CHECK (timer_ends_at IS NULL OR timer_remain_ms IS NULL)
);
`;

const MIGRATION_17_CREATE_RETIRED_KEYS_TABLE = `
CREATE TABLE IF NOT EXISTS wc_retired_keys (
  control_key TEXT PRIMARY KEY COLLATE NOCASE
);
`;

const migrateChallenges17 = (sql: SqlStorage): void => {
  sql.exec(MIGRATION_17_DROP_TEMPORARY_TABLE);
  const legacyRows = sql
    .exec<Migration17ChallengeRow>(
      `SELECT id, title, target_count, timer_total_ms, sort_order, hidden, current_count, state,
        timer_ends_at, timer_remain_ms, completed_at, created_at, updated_at
       FROM wc_challenges ORDER BY rowid`,
    )
    .toArray();
  const persistedKeys = new Set<string>();
  const allocatedKeys = new Set<string>();
  const retiredKeys = new Set<string>();
  const migratedRows = legacyRows.map((row) => {
    const controlKey = allocateControlKey([persistedKeys, allocatedKeys, retiredKeys]);
    allocatedKeys.add(controlKey);
    return { ...row, controlKey };
  });
  const insertChallenge = `INSERT INTO wc_challenges_migration_17(
  id, title, kind, unit, control_key, target_count, timer_total_ms, sort_order,
  step, best_count, hidden, current_count, state, timer_ends_at, timer_remain_ms,
  completed_at, created_at, updated_at
) VALUES (?, ?, 'counter', NULL, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?);`;
  sql.exec(MIGRATION_17_CREATE_CHALLENGES_TABLE);
  sql.exec(MIGRATION_17_CREATE_RETIRED_KEYS_TABLE);
  for (const row of migratedRows) {
    sql.exec(
      insertChallenge,
      row.id,
      row.title,
      row.controlKey,
      row.target_count,
      row.timer_total_ms,
      row.sort_order,
      row.current_count,
      row.hidden,
      row.current_count,
      row.state,
      row.timer_ends_at,
      row.timer_remain_ms,
      row.completed_at,
      row.created_at,
      row.updated_at,
    );
  }
  sql.exec(MIGRATION_17_DROP_LEGACY_TABLE);
  sql.exec(MIGRATION_17_RENAME_TABLE);
};

const MIGRATION_4_TIMER_CLEANUP = "UPDATE wc_challenges SET timer_ends_at = NULL WHERE state = 'done' AND timer_ends_at IS NOT NULL";
const MIGRATION_7_STYLE_BACKFILL = "UPDATE wc_meta SET style_id = 'plain-list', numbered = 1 WHERE style_id = 'plain-numbered'";
const MIGRATION_17_DROP_TEMPORARY_TABLE = "DROP TABLE IF EXISTS wc_challenges_migration_17";
const MIGRATION_17_DROP_LEGACY_TABLE = "DROP TABLE wc_challenges";
const MIGRATION_17_RENAME_TABLE = "ALTER TABLE wc_challenges_migration_17 RENAME TO wc_challenges";

const MIGRATIONS: readonly Migration[] = [
  { version: 1, statements: splitSqlStatements(MIGRATION_1) },
  { version: 2, guard: hasOverlayTokenEnvelope, statements: splitSqlStatements(MIGRATION_2) },
  { version: 3, statements: splitSqlStatements(MIGRATION_3) },
  { version: 4, guard: hasChallengeHidden, statements: splitSqlStatements(MIGRATION_4) },
  { version: 4, statements: [MIGRATION_4_TIMER_CLEANUP] },
  { version: 5, guard: hasChallengePlacement, statements: splitSqlStatements(MIGRATION_5) },
  { version: 6, guard: (sql) => !hasChallengeDescription(sql), statements: splitSqlStatements(MIGRATION_6) },
  { version: 7, guard: (sql) => hasChallengeMetaColumn(sql, "overflow_mode"), statements: splitSqlStatements(MIGRATION_7_OVERFLOW_MODE) },
  { version: 7, guard: (sql) => hasChallengeMetaColumn(sql, "overflow_tempo"), statements: splitSqlStatements(MIGRATION_7_OVERFLOW_TEMPO) },
  { version: 7, guard: (sql) => hasChallengeMetaColumn(sql, "numbered"), statements: splitSqlStatements(MIGRATION_7_NUMBERED) },
  { version: 7, guard: (sql) => hasChallengeMetaColumn(sql, "done_order"), statements: splitSqlStatements(MIGRATION_7_DONE_ORDER) },
  { version: 7, statements: [MIGRATION_7_STYLE_BACKFILL] },
  { version: 8, guard: (sql) => hasChallengeMetaColumn(sql, "global_timer_mode"), statements: splitSqlStatements(MIGRATION_8_GLOBAL_TIMER_MODE) },
  { version: 9, guard: hasChallengeTimerRemain, statements: splitSqlStatements(MIGRATION_9_CHALLENGE_TIMER_REMAIN) },
  { version: 10, guard: (sql) => hasChallengeMetaColumn(sql, "header_style"), statements: [MIGRATION_10_HEADER_STYLE] },
  {
    version: 11,
    guard: (sql) => hasMaxVisibleRowsCheck(sql) || hasChallengeMetaColumn(sql, "surface_mode"),
    statements: splitSqlStatements(MIGRATION_11_WC_META_REBUILD),
  },
  {
    version: 11,
    guard: (sql) => hasMaxVisibleRowsCheck(sql) || !hasChallengeMetaColumn(sql, "surface_mode"),
    statements: splitSqlStatements(MIGRATION_11_WC_META_REBUILD_LEGACY_SURFACE_MODE),
  },
  { version: 12, guard: (sql) => hasChallengeMetaColumn(sql, "font_family"), statements: [MIGRATION_12_FONT_FAMILY] },
  { version: 12, guard: (sql) => hasChallengeMetaColumn(sql, "font_scale"), statements: [MIGRATION_12_FONT_SCALE] },
  {
    version: 13,
    guard: (sql) => hasChallengeMetaColumn(sql, "surface_opacity") || !hasChallengeMetaColumn(sql, "surface_mode"),
    statements: [MIGRATION_13_SURFACE_OPACITY_ADD],
  },
  {
    version: 13,
    guard: (sql) => !(hasChallengeMetaColumn(sql, "surface_opacity") && hasChallengeMetaColumn(sql, "surface_mode")),
    statements: [MIGRATION_13_SURFACE_OPACITY_BACKFILL],
  },
  {
    version: 13,
    guard: (sql) => !(hasChallengeMetaColumn(sql, "surface_opacity") && hasChallengeMetaColumn(sql, "surface_mode")),
    statements: [MIGRATION_13_SURFACE_MODE_DROP],
  },
  { version: 14, guard: (sql) => hasChallengeMetaColumn(sql, "penalty_text"), statements: [MIGRATION_14_PENALTY_TEXT] },
  { version: 15, guard: (sql) => hasChallengeMetaColumn(sql, "penalty_label"), statements: [MIGRATION_15_PENALTY_LABEL] },
  { version: 16, guard: (sql) => hasChallengeMetaColumn(sql, "text_emphasis"), statements: [MIGRATION_16_TEXT_EMPHASIS] },
  { version: 17, run: migrateChallenges17 },
  { version: 18, guard: (sql) => hasChallengeMetaColumn(sql, "key_visible"), statements: [MIGRATION_18_KEY_VISIBLE] },
  { version: 19, guard: hasChallengeSetsTable, statements: splitSqlStatements(MIGRATION_19_SETS) },
  { version: 20, statements: [MIGRATION_20_THEME_MODE] },
];

const migrationVersionWasApplied = (sql: SqlStorage, version: number): boolean =>
  sql
    .exec<{ version: number }>(`SELECT version FROM _sql_schema_migrations WHERE version = ${String(version)}`)
    .toArray().length > 0;

const recordMigration = (sql: SqlStorage, version: number, buildId: string): void => {
  sql.exec(
    "INSERT INTO _sql_schema_migrations(version, build_id, applied_at) VALUES (?, ?, ?)",
    version,
    buildId,
    new Date().toISOString(),
  );
};

export const runMigrations = (sql: SqlStorage, buildId = "dev"): void => {
  for (let index = 0; index < MIGRATIONS.length;) {
    const version = MIGRATIONS[index]?.version;
    if (version === undefined) break;

    const firstEntry = index;
    while (index < MIGRATIONS.length && MIGRATIONS[index]?.version === version) index += 1;
    const entries = MIGRATIONS.slice(firstEntry, index);
    const versionWasApplied = version === 1 ? false : migrationVersionWasApplied(sql, version);

    if (!versionWasApplied) {
      for (const migration of entries) {
        if (migration.guard?.(sql) === true) continue;
        if (migration.run !== undefined) migration.run(sql);
        else for (const statement of migration.statements) sql.exec(statement);
      }
    }

    // Migration 1 muss vor dem ersten Ledger-Check die Ledger-Tabelle anlegen.
    // Danach gilt auch für sie dieselbe Eintragslogik wie für alle Folgemigrationen.
    if (version === 1 ? !migrationVersionWasApplied(sql, version) : !versionWasApplied) {
      recordMigration(sql, version, buildId);
    }
  }
};
