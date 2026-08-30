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

const hasOverlayTokenEnvelope = (sql: SqlStorage): boolean =>
  sql
    .exec<{ name: string }>("PRAGMA table_info(overlay_tokens)")
    .toArray()
    .some((column) => column.name === "token_envelope");

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
};
