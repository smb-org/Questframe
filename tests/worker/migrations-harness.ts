import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

import { runMigrations } from "../../src/channel/migrations";

export type SqliteMasterRow = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
};

export type SchemaSnapshot = readonly SqliteMasterRow[];

const normalizeSchemaSql = (sql: string | null): string | null => {
  if (sql === null) return null;

  // SQL-Strings bleiben als ein Token erhalten; nur DDL-Whitespace und
  // einfache, von SQLite gesetzte Identifier-Anfuehrungszeichen werden
  // vereinheitlicht.
  const tokens = sql.match(/'(?:''|[^'])*'|"(?:[^"]|"")*"|[(),;]|[^\s'",();]+/g) ?? [];
  if (tokens.at(-1) === ";") tokens.pop();

  return tokens
    .map((token) => {
      if (!token.startsWith('"') || !token.endsWith('"')) return token;
      const identifier = token.slice(1, -1).replaceAll('""', '"');
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) ? identifier : token;
    })
    .join(" ");
};

/**
 * Der Snapshot vergleicht die semantische DDL-Form, nicht SQLite's zufaellige
 * Quote-/Whitespace-Darstellung (zum Beispiel nach Rebuild und Rename).
 * Bewusst ausgeschlossen sind Eintraege mit `name LIKE 'sqlite_%'`: Das
 * entfernt Autoindex-Eintraege und `sqlite_sequence`; diese Hilfsobjekte sind
 * kein Teil des von diesem Harness bewerteten Anwendungsschemas.
 */
export const readSchemaSnapshot = (sql: SqlStorage): SchemaSnapshot =>
  sql
    .exec<SqliteMasterRow>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .toArray()
    .map((row) => ({ ...row, sql: normalizeSchemaSql(row.sql) }));

type DatabaseInitializer = (sql: SqlStorage, version: number) => void;

const makeStub = (label: string) =>
  env.CHANNEL.get(env.CHANNEL.idFromName(`migration-harness-${label}-${crypto.randomUUID()}`));

/**
 * Führt einen Datenbank-Callback in einer isolierten DO-Instanz aus. Die
 * optionale Initialisierung bleibt beim jeweiligen Test: Der Registry-Test
 * startet absichtlich mit einer leeren Datenbank, der Migrationstest legt
 * seinen historischen Fixture-Stand an.
 */
export const withHistoricalDatabase = async <T>(
  version: number,
  callback: (sql: SqlStorage) => T,
  initialize: DatabaseInitializer = () => {},
): Promise<T> => {
  const stub = makeStub(`v${String(version)}`);
  return runInDurableObject(stub, (_instance, state) => {
    initialize(state.storage.sql, version);
    return callback(state.storage.sql);
  });
};

/**
 * Baut aus dem aktuellen V16-Fixture einen echten Stand 17 für isolierte
 * Migration-18-Tests. Die Rücknahme der erst danach eingeführten Spalte ist
 * ausschließlich Test-Fixture-Setup; die Produktionsmigration bleibt ein
 * reines ALTER TABLE ADD COLUMN.
 */
export const prepareVersion17Database = (sql: SqlStorage): void => {
  runMigrations(sql, "migration-harness-prepare-v17");
  sql.exec("DELETE FROM _sql_schema_migrations WHERE version = 18");
  sql.exec("ALTER TABLE wc_meta DROP COLUMN key_visible");
};
