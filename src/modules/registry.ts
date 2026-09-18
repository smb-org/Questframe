/**
 * Modul-Registry-Vertrag (P1, siehe
 * docs/designs/roadmap-modul-registry-und-challenge-typen.md, Track P).
 *
 * Deklarativer Modulvertrag: Der optionale `handle()`-Eintrag ist der einzige
 * imperative Einstieg für die Modul-HTTP-Fassade. Der Selbsttest dafür liegt in
 * `tests/worker/module-registry.test.ts` und prüft die Werte hier gegen den
 * echten Code.
 *
 * `ModuleId` wird weiter unten aus der Registry abgeleitet. Ein drittes Modul
 * soll nur einen weiteren Registry-Eintrag kosten, keine zentrale
 * Typänderung. Eindeutigkeit sichert der Selbsttest, nicht der Compiler.
 *
 */
import { createChallengeHttpHandler } from "./win-challenges/adapters/http-facade";

export type ModuleContext = {
  sql: SqlStorage;
  transactionSync: <T>(fn: () => T) => T;
  /** Wirft, wenn keine gültige Editor-Session anliegt. */
  requireSession: (request: Request) => void;
  /** Session und CSRF in einem Schritt; die beiden treten nie getrennt auf. */
  requireSessionAndCsrf: (request: Request) => Promise<void>;
  requireDockToken: (request: Request) => Promise<void>;
  /** Sendet an alle Sockets mit diesen Tags. */
  broadcast: (tags: readonly string[], payload: unknown) => void;
  /** Schließt alle Sockets mit diesem Tag. */
  revokeTokenSockets: (tag: string) => void;
};

export type ModuleHandler = (request: Request, ctx: ModuleContext) => Promise<Response | null>;

/**
 * Tabellenbesitz als explizite Liste oder als Präfix. Ein reines Präfix
 * reicht nicht für jedes Modul: das HUD trägt historische Namen
 * (`channel_state`, `state_history`, `audit_log`) ohne gemeinsames Präfix.
 */
export type ModuleTables =
  | { kind: "prefix"; prefix: string }
  | { kind: "explicit"; tables: readonly string[] };

type OverlayModuleDefinition = {
  id: string;
  /** DO-interne Routenpräfixe, z.B. ["/challenges"]. Nicht die öffentliche `/api/*`-Oberfläche. */
  routePrefixes: readonly string[];
  socketPaths: readonly string[];
  socketTags: readonly string[];
  tables: ModuleTables;
  wireScopes: readonly string[];
  migrationNamespace: string;
  handle?: ModuleHandler;
  /** Deklarations-Labels aus den Build-Budget-Definitionen. */
  budgetKeys: readonly string[];
};

/**
 * HUD: `ChannelState`, `readState`/`writeState`, Undo. Sockets/Routen laut
 * `channel-object.ts` — `/ws/overlay` erhält nur `state_committed`
 * (`broadcastState`), nie Challenge-Updates. `/ws/editor` und `/ws/composite`
 * bedienen beide Module gemeinsam und gehören deshalb keinem der beiden
 * (Host-Plattform, siehe Selbsttest).
 */
const hudModule = {
  id: "hud",
  routePrefixes: ["/state", "/overlay-visibility"],
  socketPaths: ["/ws/overlay"],
  socketTags: ["overlay"],
  tables: {
    kind: "explicit",
    tables: ["channel_state", "state_history", "audit_log"],
  },
  // Die HUD-Nachrichten (`state_committed`) tragen kein `scope`-Feld.
  wireScopes: [],
  migrationNamespace: "hud",
  budgetKeys: ["Overlay"],
} as const satisfies OverlayModuleDefinition;

/**
 * Challenges: vier Socket-Arten teilen sich `channel-object.ts` laut Plan
 * („Vier Socket-Arten, drei Regeln"), `"challenge"` und `"dock"` gehören dem
 * Modul. Tabellenpräfix `wc_` (`sql-storage-challenge-repository.ts` →
 * tatsächlich `adapters/sql-storage-challenge-repository.ts:36`,
 * `TABLE_PREFIX`).
 */
const challengesModuleDefinition = {
  id: "challenges",
  routePrefixes: ["/challenges"],
  socketPaths: ["/ws/challenge", "/ws/dock"],
  socketTags: ["challenge", "dock"],
  tables: { kind: "prefix", prefix: "wc_" },
  wireScopes: ["challenge", "global"],
  migrationNamespace: "challenges",
  budgetKeys: [
    "Challenge-Quelle",
    "Live-Seite",
    "Challenge-Style-Chunk (variantMax)",
  ],
} as const satisfies OverlayModuleDefinition;

const challengesModule = {
  ...challengesModuleDefinition,
  handle: createChallengeHttpHandler(challengesModuleDefinition.socketTags),
} as const satisfies OverlayModuleDefinition;

/**
 * Ableitungsquelle. `as const` hält die Literaltypen, aus denen `ModuleId`
 * entsteht — ein drittes Modul kostet damit genau einen Eintrag hier und
 * keine Typänderung daneben.
 */
const REGISTRY_ENTRIES = [hudModule, challengesModule] as const satisfies readonly OverlayModuleDefinition[];

export type ModuleId = (typeof REGISTRY_ENTRIES)[number]["id"];
export type OverlayModule = OverlayModuleDefinition & { id: ModuleId };

/**
 * Zugriffssicht auf dieselben Einträge. Nötig, weil `as const` optionale
 * Member wegkürzt: `hudModule` setzt kein `handle`, und über die
 * Literaltypen wäre `module.handle` deshalb gar kein Member.
 */
export const MODULE_REGISTRY: readonly OverlayModule[] = REGISTRY_ENTRIES;
