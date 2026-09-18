import { describe, expect, it } from "vitest";

import { runMigrations } from "../../src/channel/migrations";
import {
  HOST_SOCKET_TAGS as REGISTRY_HOST_SOCKET_TAGS,
  MODULE_REGISTRY,
  type ModuleContext,
  type ModuleTables,
  type OverlayModule,
} from "../../src/modules/registry";
import { readSchemaSnapshot, withHistoricalDatabase } from "./migrations-harness";

import CHANNEL_OBJECT_SOURCE from "../../src/channel/channel-object.ts?raw";
import CHALLENGE_FACADE_SOURCE from "../../src/modules/win-challenges/adapters/http-facade.ts?raw";
import WIRE_CONTRACT_SOURCE from "../../src/shared/contracts/win-challenges.ts?raw";
import SCHEMAS_SOURCE from "../../src/modules/win-challenges/contracts/schemas.ts?raw";
import MIGRATIONS_TEST_SOURCE from "./migrations.test.ts?raw";
import MIGRATIONS_HARNESS_TEST_SOURCE from "./migrations-harness.ts?raw";
import CHANNEL_TEST_SOURCE from "./channel.test.ts?raw";
import WIN_CHALLENGES_REPOSITORY_TEST_SOURCE from "./win-challenges-repository.test.ts?raw";
import {
  createBudgetDeclarations,
  type BuildBudgetDeclaration,
} from "../../scripts/lib/build-budget-declarations.mjs";

/**
 * Tabellen, die `runMigrations` anlegt, aber die zu keinem Modul gehören:
 * Sessions, CSRF, OAuth, Overlay-/Dock-Tokens, Media, Twitch-Cache, die
 * plattformweite state_history/audit_log-Historie — plus
 * `_sql_schema_migrations`, vom Eng-Review ausdrücklich als Host-Tabelle
 * ergänzt (Beschlüsse aus dem Eng-Review, 2026-09-10).
 */
const HOST_TABLES: readonly string[] = [
  "_sql_schema_migrations",
  "editor_sessions",
  "csrf_tokens",
  "oauth_nonces",
  "overlay_tokens",
  "media_blobs",
  "media_leases",
  "twitch_user_cache",
  "state_history",
  "audit_log",
];

/**
 * DO-Routen, die die Host-Plattform behandelt: Authentifizierung, Bootstrap,
 * Token-/Media-Verwaltung und die gemeinsame Socket-Notbremse.
 */
const HOST_ROUTE_PATHS: readonly string[] = [
  "/internal/session/dev",
  "/internal/oauth/nonce",
  "/internal/oauth/consume",
  "/internal/session/oauth",
  "/internal/auth/material",
  "/internal/auth/confirm",
  "/internal/twitch/cache",
  "/internal/session/logout",
  "/editor/bootstrap",
  "/overlay-token",
  "/overlay-token/rotate",
  "/sockets/flush",
  "/media",
  "/media/leases/renew",
];

/** Editor und Composite sind gemeinsame Host-Sockets für beide Module. */
const HOST_SOCKET_PATHS: readonly string[] = ["/ws/editor", "/ws/composite"];
const HOST_SOCKET_TAGS: readonly string[] = REGISTRY_HOST_SOCKET_TAGS;

/**
 * Deklarations-Labels aus den Build-Budget-Definitionen, die keiner der beiden
 * Module gehören: Admin- und Temporal-/QR-Code-Chunks bedienen alle
 * Workspaces, Composite-Quelle mischt HUD und Challenges in einem Dokument.
 * Worker-Bundle und Audio-Summe sind direkt im Prüfer erzeugte Host-Labels.
 */
const HOST_BUDGET_KEYS: readonly string[] = [
  "Admin", // Gemeinsame Bedienfläche, kein einzelnes Registry-Modul.
  "Temporal", // Geteilter Lazy-Code, der nicht zu einer Oberfläche gehört.
  "QR-Code Chunk", // Geteilter Lazy-Code, der nicht zu einer Oberfläche gehört.
  "Composite-Quelle", // Mischt HUD und Challenges in einem Dokument.
  "Worker bundle", // Globales Worker-Gate aus dem Budgetprüfer.
  "Audio total", // Globales Asset-Gate aus dem Budgetprüfer.
];

const HOST_DIRECT_BUDGET_KEYS: readonly string[] = ["Worker bundle", "Audio total"];

const labelsOf = (declarations: readonly BuildBudgetDeclaration[]): readonly string[] =>
  declarations.flatMap((declaration) => (declaration.label === undefined ? [] : [declaration.label]));

const REAL_BUDGET_DECLARATION_LABELS: ReadonlySet<string> = new Set(
  labelsOf(createBudgetDeclarations("temporal-entry", ["style-entry"], "qr-entry")),
);
const REAL_BUDGET_KEYS: ReadonlySet<string> = new Set([
  ...REAL_BUDGET_DECLARATION_LABELS,
  ...HOST_DIRECT_BUDGET_KEYS,
]);

const tablesOf = (tables: ModuleTables): readonly string[] =>
  tables.kind === "explicit" ? tables.tables : [];

const claimsTable = (tables: ModuleTables, tableName: string): boolean =>
  tables.kind === "prefix" ? tableName.startsWith(tables.prefix) : tables.tables.includes(tableName);

const sourceValues = (source: string, pattern: RegExp): readonly string[] => {
  const values: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const value = match[1];
    if (value === undefined) throw new Error("Regex-Treffer ohne Capture-Group.");
    values.push(value);
  }
  return [...new Set(values)];
};

/**
 * Sucht nur String-Literale im Code. Kommentare und Routen wie `/challenges`
 * passieren den Wächter absichtlich; es gibt keine Ausnahme für echte Tags.
 */
const collectExactSocketTagLiterals = (source: string): readonly string[] => {
  const values: string[] = [];
  let state: "code" | "line-comment" | "block-comment" | "single-quote" | "double-quote" = "code";
  let quoteValue = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];
    if (character === undefined) break;
    if (state === "code") {
      if (character === "/" && nextCharacter === "/") {
        state = "line-comment";
        index += 1;
      } else if (character === "/" && nextCharacter === "*") {
        state = "block-comment";
        index += 1;
      } else if (character === "'") {
        state = "single-quote";
        quoteValue = "";
      } else if (character === '"') {
        state = "double-quote";
        quoteValue = "";
      }
      continue;
    }
    if (state === "line-comment") {
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && nextCharacter === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if ((state === "single-quote" && character === "'") || (state === "double-quote" && character === '"')) {
      if (quoteValue === "challenge" || quoteValue === "dock") values.push(quoteValue);
      state = "code";
      continue;
    }
    quoteValue += character;
  }
  return values;
};

const fetchStart = CHANNEL_OBJECT_SOURCE.indexOf("  override async fetch(request: Request): Promise<Response> {");
const fetchEnd = CHANNEL_OBJECT_SOURCE.indexOf("  private async createDevSession(request: Request): Promise<Response> {");
if (fetchStart < 0 || fetchEnd <= fetchStart) throw new Error("Konnte den ChannelObject-fetch-Pfad nicht abgrenzen.");
const CHANNEL_FETCH_SOURCE = CHANNEL_OBJECT_SOURCE.slice(fetchStart, fetchEnd);
const REAL_DO_ROUTE_PATHS = [
  ...sourceValues(CHANNEL_FETCH_SOURCE, /url\.pathname\s*===\s*"([^"]+)"/gu),
  ...sourceValues(CHALLENGE_FACADE_SOURCE, /(?:url\.)?pathname\s*===\s*"([^"]+)"/gu),
];
const REAL_SOCKET_PATHS = REAL_DO_ROUTE_PATHS.filter((path) => path.startsWith("/ws/"));
const REAL_LITERAL_SOCKET_TAGS = sourceValues(
  CHANNEL_OBJECT_SOURCE,
  /(?:acceptWebSocket\(\s*server,\s*\[|getWebSockets\(\s*|connectPresenceSocket\(\s*request,\s*)"([^"]+)"/gu,
);
const REAL_REGISTRY_SOCKET_TAGS = sourceValues(CHANNEL_OBJECT_SOURCE, /SOCKETS\.([a-z]+)\.tag/gu);
const REAL_SOCKET_TAGS = [...new Set([...REAL_LITERAL_SOCKET_TAGS, ...REAL_REGISTRY_SOCKET_TAGS])];

/**
 * Zerlegt Quelltext in seine String- und Template-Literale (Kommentare
 * ausgeklammert) und liefert deren statischen Textinhalt. `${...}`-
 * Interpolationen in Template-Literalen werden als eigener Code-Bereich
 * behandelt (mit Klammerzählung für verschachtelte `{}`); ihr Text fließt
 * nicht in den Literal-Inhalt ein, das umgebende Template bleibt aber ein
 * zusammenhängender Treffer. Grundlage für den Ledger-Namespace-Wächter
 * unten, der so auch Template-Literal-SQL (z. B. `sql.exec(\`...\`)`)
 * erfasst, die das zeichenweise Muster des Socket-Tag-Wächters oben nicht
 * abdeckt.
 */
const extractStringLiterals = (source: string): readonly string[] => {
  const literals: string[] = [];
  type Frame =
    | { kind: "code" }
    | { kind: "interpolation"; depth: number }
    | { kind: "line-comment" }
    | { kind: "block-comment" }
    | { kind: "single"; value: string }
    | { kind: "double"; value: string }
    | { kind: "template"; value: string };

  const stack: Frame[] = [{ kind: "code" }];

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];
    if (character === undefined) break;
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;

    if (frame.kind === "code" || frame.kind === "interpolation") {
      if (character === "/" && nextCharacter === "/") {
        stack.push({ kind: "line-comment" });
        index += 1;
      } else if (character === "/" && nextCharacter === "*") {
        stack.push({ kind: "block-comment" });
        index += 1;
      } else if (character === "'") {
        stack.push({ kind: "single", value: "" });
      } else if (character === '"') {
        stack.push({ kind: "double", value: "" });
      } else if (character === "`") {
        stack.push({ kind: "template", value: "" });
      } else if (frame.kind === "interpolation" && character === "{") {
        frame.depth += 1;
      } else if (frame.kind === "interpolation" && character === "}") {
        if (frame.depth === 0) stack.pop();
        else frame.depth -= 1;
      }
      continue;
    }

    if (frame.kind === "line-comment") {
      if (character === "\n") stack.pop();
      continue;
    }

    if (frame.kind === "block-comment") {
      if (character === "*" && nextCharacter === "/") {
        stack.pop();
        index += 1;
      }
      continue;
    }

    // Ab hier: String- oder Template-Literal. Escapes tragen nichts zur
    // Textsuche bei, es reicht, sie zu überspringen.
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (frame.kind === "single") {
      if (character === "'") {
        literals.push(frame.value);
        stack.pop();
      } else frame.value += character;
      continue;
    }
    if (frame.kind === "double") {
      if (character === '"') {
        literals.push(frame.value);
        stack.pop();
      } else frame.value += character;
      continue;
    }
    if (character === "`") {
      literals.push(frame.value);
      stack.pop();
    } else if (character === "$" && nextCharacter === "{") {
      stack.push({ kind: "interpolation", depth: 0 });
      index += 1;
    } else {
      frame.value += character;
    }
  }

  return literals;
};

const LEDGER_MUTATION_PATTERN = /\b(?:FROM|INTO|UPDATE)\s+_sql_schema_migrations\b/;

type NamespaceGuardException = {
  readonly file: string;
  readonly reason: string;
  readonly matches: (literal: string) => boolean;
};

/**
 * Ausnahmen vom Ledger-Namespace-Wächter unten: Fixtures, die absichtlich
 * das alte Vor-Namespace-Ledgerschema (`version INTEGER PRIMARY KEY`, keine
 * `namespace`-Spalte) nachbauen, um den Backfill-Pfad bzw. historische
 * Migrationsstände zu testen. Eng genug gefasst, dass jede Ausnahme
 * ausschließlich ihre eine begründete Stelle trifft, keine echte Lücke.
 */
const NAMESPACE_GUARD_EXCEPTIONS: readonly NamespaceGuardException[] = [
  {
    file: "migrations.test.ts",
    reason:
      "insertMigrationLedger baut für historische Fixtures bewusst das alte, noch Namespace-lose Ledger nach.",
    matches: (literal) =>
      literal === "INSERT INTO _sql_schema_migrations(version, build_id, applied_at) VALUES (?, ?, ?)",
  },
  {
    file: "win-challenges-repository.test.ts",
    reason:
      "Baut testweise das alte Vor-Namespace-Ledgerschema nach (eigene CREATE TABLE ohne namespace-Spalte), um Migrationen auf einem historischen Stand zu prüfen.",
    matches: (literal) =>
      literal.includes("CREATE TABLE _sql_schema_migrations")
      && literal.includes("INSERT INTO _sql_schema_migrations(version, build_id, applied_at)"),
  },
];

const LEDGER_NAMESPACE_GUARD_TARGETS: readonly { file: string; source: string }[] = [
  { file: "migrations.test.ts", source: MIGRATIONS_TEST_SOURCE },
  { file: "migrations-harness.ts", source: MIGRATIONS_HARNESS_TEST_SOURCE },
  { file: "channel.test.ts", source: CHANNEL_TEST_SOURCE },
  { file: "win-challenges-repository.test.ts", source: WIN_CHALLENGES_REPOSITORY_TEST_SOURCE },
];

const routePrefixClaims = (prefix: string, path: string): boolean =>
  path.startsWith(prefix);

const routePrefixesOverlap = (left: string, right: string): boolean =>
  left.startsWith(right) || right.startsWith(left);

const collectRoutePrefixOverlaps = (modules: readonly OverlayModule[]): string[] => {
  const overlaps: string[] = [];
  for (let leftIndex = 0; leftIndex < modules.length; leftIndex += 1) {
    const left = modules[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < modules.length; rightIndex += 1) {
      const right = modules[rightIndex];
      if (right === undefined) continue;
      for (const leftPrefix of left.routePrefixes) {
        for (const rightPrefix of right.routePrefixes) {
          if (routePrefixesOverlap(leftPrefix, rightPrefix)) {
            overlaps.push(`${left.id}:${leftPrefix} <> ${right.id}:${rightPrefix}`);
          }
        }
      }
    }
  }
  return overlaps;
};

/** Sammelt Duplikate über ein Feld hinweg — für die Kollisionsprüfungen unten. */
const collectDuplicates = (
  modules: readonly OverlayModule[],
  pick: (module: OverlayModule) => readonly string[],
): Map<string, string[]> => {
  const owners = new Map<string, string[]>();
  for (const module of modules) {
    for (const value of pick(module)) {
      owners.set(value, [...(owners.get(value) ?? []), module.id]);
    }
  }
  return new Map([...owners].filter(([, moduleIds]) => moduleIds.length > 1));
};

describe("Modul-Registry-Selbsttest", () => {
  it("verhindert Challenge- und Dock-Tag-Literale im Socket-Host", () => {
    expect(collectExactSocketTagLiterals(CHANNEL_OBJECT_SOURCE)).toEqual([]);
  });

  it("hält jede Ledger-Abfrage der Migrationstests an einen Namespace-Filter", () => {
    const violations: string[] = [];
    for (const { file, source } of LEDGER_NAMESPACE_GUARD_TARGETS) {
      for (const literal of extractStringLiterals(source)) {
        if (!LEDGER_MUTATION_PATTERN.test(literal)) continue;
        if (literal.includes("namespace")) continue;
        const isExcepted = NAMESPACE_GUARD_EXCEPTIONS.some(
          (exception) => exception.file === file && exception.matches(literal),
        );
        if (isExcepted) continue;
        violations.push(`${file}: ${literal}`);
      }
    }
    expect(violations, "Ledger-Abfrage/-Mutation ohne Namespace-Filter gefunden").toEqual([]);
  });

  it("hat eindeutige Modul-IDs", () => {
    const ids = MODULE_REGISTRY.map((module) => module.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("beansprucht keinen Routenpräfix doppelt", () => {
    expect(collectDuplicates(MODULE_REGISTRY, (module) => module.routePrefixes)).toEqual(new Map());
    expect(collectRoutePrefixOverlaps(MODULE_REGISTRY)).toEqual([]);
  });

  it("hat nur beim Challenges-Modul einen optionalen HTTP-Handler", () => {
    const hud = MODULE_REGISTRY.find((module) => module.id === "hud");
    const challenges = MODULE_REGISTRY.find((module) => module.id === "challenges");
    expect(hud?.handle).toBeUndefined();
    expect(challenges?.handle).toEqual(expect.any(Function));
  });

  it("behandelt die beiden Dock-Token-Routen in der Fassade vor dem Body-Parse", async () => {
    const challenges = MODULE_REGISTRY.find((module) => module.id === "challenges");
    if (challenges?.handle === undefined) throw new Error("Challenges-Handler fehlt.");
    const authError = new Error("Authentifizierung zuerst");
    const context = {
      requireSessionAndCsrf: () => Promise.reject(authError),
    } as unknown as ModuleContext;
    for (const pathname of ["/challenges/dock-token", "/challenges/dock-token/rotate"]) {
      await expect(
        challenges.handle(
          new Request(`https://channel.internal${pathname}`, {
            method: "POST",
            body: "kein JSON",
          }),
          context,
        ),
      ).rejects.toBe(authError);
    }
  });

  it("behandelt verschachtelte Routenpräfixe als Überlappung", () => {
    expect(routePrefixesOverlap("/state", "/state/undo")).toBe(true);
  });

  it("jede reale DO-Route gehört genau einem Modul oder der Host-Liste", () => {
    for (const route of REAL_DO_ROUTE_PATHS.filter((path) => !path.startsWith("/ws/"))) {
      const moduleOwners = MODULE_REGISTRY.filter((module) =>
        module.routePrefixes.some((prefix) => routePrefixClaims(prefix, route)),
      ).map((module) => module.id);
      const isHost = HOST_ROUTE_PATHS.includes(route);

      expect(
        moduleOwners.length <= 1,
        `DO-Route "${route}" gehört mehreren Modulen: ${moduleOwners.join(", ")}.`,
      ).toBe(true);
      expect(
        !(isHost && moduleOwners.length > 0),
        `DO-Route "${route}" steht auf der Host-Liste und gehört gleichzeitig Modul "${String(moduleOwners[0])}".`,
      ).toBe(true);
      expect(
        isHost || moduleOwners.length === 1,
        `DO-Route "${route}" gehört keinem Modul und steht nicht auf der Host-Liste (herrenlos).`,
      ).toBe(true);
    }
    for (const hostRoute of HOST_ROUTE_PATHS) {
      expect(REAL_DO_ROUTE_PATHS).toContain(hostRoute);
    }
  });

  it("beansprucht keinen Socket-Pfad doppelt", () => {
    expect(collectDuplicates(MODULE_REGISTRY, (module) => module.socketPaths)).toEqual(new Map());
  });

  it("jeder reale Socket-Pfad gehört genau einem Modul oder der Host-Liste", () => {
    for (const path of REAL_SOCKET_PATHS) {
      const moduleOwners = MODULE_REGISTRY.filter((module) => module.socketPaths.some((value) => value === path)).map(
        (module) => module.id,
      );
      const isHost = HOST_SOCKET_PATHS.includes(path);

      expect(moduleOwners.length <= 1, `Socket-Pfad "${path}" gehört mehreren Modulen.`).toBe(true);
      expect(!(isHost && moduleOwners.length > 0), `Host-Socket "${path}" gehört zusätzlich einem Modul.`).toBe(true);
      expect(isHost || moduleOwners.length === 1, `Socket-Pfad "${path}" ist herrenlos.`).toBe(true);
    }
    for (const hostPath of HOST_SOCKET_PATHS) {
      expect(REAL_SOCKET_PATHS).toContain(hostPath);
    }
  });

  it("beansprucht keinen Socket-Tag doppelt", () => {
    expect(collectDuplicates(MODULE_REGISTRY, (module) => module.socketTags)).toEqual(new Map());
  });

  it("jeder reale Socket-Tag gehört genau einem Modul oder der Host-Liste", () => {
    for (const tag of REAL_SOCKET_TAGS) {
      const moduleOwners = MODULE_REGISTRY.filter((module) => module.socketTags.some((value) => value === tag)).map(
        (module) => module.id,
      );
      const isHost = HOST_SOCKET_TAGS.includes(tag);

      expect(moduleOwners.length <= 1, `Socket-Tag "${tag}" gehört mehreren Modulen.`).toBe(true);
      expect(!(isHost && moduleOwners.length > 0), `Host-Tag "${tag}" gehört zusätzlich einem Modul.`).toBe(true);
      expect(isHost || moduleOwners.length === 1, `Socket-Tag "${tag}" ist herrenlos.`).toBe(true);
    }
    for (const hostTag of HOST_SOCKET_TAGS) {
      expect(REAL_SOCKET_TAGS).toContain(hostTag);
    }
  });

  it("beansprucht keinen Wire-Scope doppelt", () => {
    expect(collectDuplicates(MODULE_REGISTRY, (module) => module.wireScopes)).toEqual(new Map());
  });

  it("beansprucht keine explizite Tabelle doppelt", () => {
    expect(collectDuplicates(MODULE_REGISTRY, (module) => tablesOf(module.tables))).toEqual(new Map());
  });

  it("hat _sql_schema_migrations auf der Host-Liste", () => {
    expect(HOST_TABLES).toContain("_sql_schema_migrations");
  });

  it("jede Socket-Tag- und Socket-Pfad-Deklaration kommt in channel-object.ts vor", () => {
    for (const module of MODULE_REGISTRY) {
      for (const tag of module.socketTags) {
        expect(
          REAL_SOCKET_TAGS.includes(tag),
          `Socket-Tag "${tag}" von Modul "${module.id}" kommt nicht in channel-object.ts vor.`,
        ).toBe(true);
      }
      for (const path of module.socketPaths) {
        expect(
          REAL_SOCKET_PATHS.includes(path),
          `Socket-Pfad "${path}" von Modul "${module.id}" kommt nicht in channel-object.ts vor.`,
        ).toBe(true);
      }
      for (const prefix of module.routePrefixes) {
        expect(
          REAL_DO_ROUTE_PATHS.some((path) => routePrefixClaims(prefix, path)),
          `Routenpräfix "${prefix}" von Modul "${module.id}" kommt nicht in channel-object.ts vor.`,
        ).toBe(true);
      }
    }
  });

  it("jeder deklarierte Wire-Scope kommt im Wire-Vertrag vor", () => {
    const wireSource = `${WIRE_CONTRACT_SOURCE}\n${SCHEMAS_SOURCE}`;
    for (const module of MODULE_REGISTRY) {
      for (const scope of module.wireScopes) {
        const pattern = new RegExp(`scope[\\s\\S]{0,20}"${scope}"`, "u");
        expect(
          pattern.test(wireSource),
          `Wire-Scope "${scope}" von Modul "${module.id}" kommt nicht im Wire-Vertrag vor.`,
        ).toBe(true);
      }
    }
  });

  it("jede Tabelle, die runMigrations anlegt, gehört genau einem Modul oder der Host-Liste", async () => {
    const schema = await withHistoricalDatabase(0, (sql) => {
      runMigrations(sql, "module-registry-selftest");
      return readSchemaSnapshot(sql);
    });
    const realTables = schema.filter(({ type }) => type === "table").map(({ name }) => name);
    expect(realTables.length, "runMigrations hat keine Tabelle angelegt — Testaufbau prüfen.").toBeGreaterThan(0);

    for (const tableName of realTables) {
      const moduleOwners = MODULE_REGISTRY.filter((module) => claimsTable(module.tables, tableName)).map(
        (module) => module.id,
      );
      const isHost = HOST_TABLES.includes(tableName);

      expect(
        moduleOwners.length <= 1,
        `Tabelle "${tableName}" gehört mehreren Modulen: ${moduleOwners.join(", ")}.`,
      ).toBe(true);
      expect(
        !(isHost && moduleOwners.length > 0),
        `Tabelle "${tableName}" steht auf der Host-Liste und gehört gleichzeitig Modul "${String(moduleOwners[0])}".`,
      ).toBe(true);
      expect(
        isHost || moduleOwners.length === 1,
        `Tabelle "${tableName}" gehört keinem Modul und steht nicht auf der Host-Liste (herrenlos).`,
      ).toBe(true);
    }

    // Umgekehrt: jede vom Vertrag beanspruchte Tabelle muss real existieren.
    for (const module of MODULE_REGISTRY) {
      for (const tableName of tablesOf(module.tables)) {
        expect(
          realTables.includes(tableName),
          `Modul "${module.id}" beansprucht Tabelle "${tableName}", die runMigrations nicht anlegt.`,
        ).toBe(true);
      }
    }
    for (const hostTable of HOST_TABLES) {
      expect(realTables.includes(hostTable), `Host-Tabelle "${hostTable}" existiert nicht (mehr).`).toBe(true);
    }
  });

  it("ordnet jedes echte Budget-Label genau einem Modul oder dem Host zu", () => {
    const realBudgetKeys = REAL_BUDGET_KEYS;
    expect(realBudgetKeys.size, "Konnte keine Budget-Labels aus den Deklarationen ermitteln.").toBeGreaterThan(0);

    const claimed = new Map<string, string[]>();
    for (const module of MODULE_REGISTRY) {
      for (const key of module.budgetKeys) {
        expect(
          REAL_BUDGET_DECLARATION_LABELS.has(key),
          `budgetKey "${key}" von Modul "${module.id}" ist kein Deklarations-Label.`,
        ).toBe(true);
        claimed.set(key, [...(claimed.get(key) ?? []), module.id]);
      }
    }
    for (const key of HOST_BUDGET_KEYS) {
      expect(
        realBudgetKeys.has(key),
        `Host-Budget "${key}" ist kein Deklarations-Label und nicht als Host-Budget bekannt.`,
      ).toBe(true);
      claimed.set(key, [...(claimed.get(key) ?? []), "host"]);
    }

    for (const [key, owners] of claimed) {
      expect(owners.length, `Budget "${key}" gehört mehreren Besitzern: ${owners.join(", ")}.`).toBe(1);
    }
    for (const key of realBudgetKeys) {
      expect(claimed.has(key), `Budget "${key}" gehört keinem Modul und steht nicht auf der Host-Liste (herrenlos).`).toBe(
        true,
      );
    }
  });
});
