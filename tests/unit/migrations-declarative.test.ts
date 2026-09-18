import { describe, expect, it } from "vitest";

import { runMigrations } from "../../src/channel/migrations";

const countStatements = (sql: string): number =>
  sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .length;

describe("Deklarativer Migrations-Runner", () => {
  it("führt jedes SQL-Statement in einem eigenen exec aus", () => {
    const executed: string[] = [];
    const sql = {
      exec<T>(statement: string): { toArray: () => T[] } {
        if (countStatements(statement) > 1) {
          throw new Error("Ein exec darf nur ein SQL-Statement enthalten.");
        }
        executed.push(statement);
        return {
          toArray: () => (statement === "SELECT version FROM _sql_schema_migrations WHERE version = 1"
            ? [{ version: 1 } as T]
            : []),
        };
      },
    } as unknown as SqlStorage;

    expect(() => {
      runMigrations(sql, "declarative-test");
    }).not.toThrow();
    expect(executed.some((statement) => statement.includes("CREATE TABLE IF NOT EXISTS channel_state"))).toBe(true);
    expect(executed.some((statement) => statement.includes("CREATE TABLE wc_meta_migration_11"))).toBe(true);
    expect(executed.some((statement) => statement.includes("CREATE TABLE wc_challenges_migration_17"))).toBe(true);
    expect(executed.some((statement) => statement.includes("CREATE TABLE IF NOT EXISTS wc_sets"))).toBe(true);
    expect(executed.every((statement) => countStatements(statement) === 1)).toBe(true);
  });
});
