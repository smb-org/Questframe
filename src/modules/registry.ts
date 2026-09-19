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
import { createChallengeHttpHandler, challengeHistory } from "./win-challenges/adapters/http-facade";
import { createHudModule } from "./hud/http-facade";
import type { DockTokenRecord } from "./win-challenges/repository/challenge-repository";
import type { AuditEntry, UndoTarget } from "../shared/contracts/api";
import type { ChannelState } from "../shared/contracts/state";
import type { SocketLimitKey } from "../shared/contracts/api";
import { DOCK_SOCKET_PROTOCOL, OVERLAY_SOCKET_PROTOCOL } from "../shared/contracts/protocol";

type SocketDefinitionInput = {
  readonly tag: string;
  readonly limitKey: SocketLimitKey;
  readonly display: boolean;
  readonly protocol: string | null;
};

/** Gemeinsame Host-Sockets fuer Editor und Composite; sie gehoeren keinem Modul. */
export const HOST_SOCKET_TAGS = ["editor", "composite"] as const;

const HOST_SOCKET_DEFINITIONS = [
  {
    tag: HOST_SOCKET_TAGS[0],
    limitKey: "maxEditorSockets",
    display: false,
    protocol: null,
  },
  {
    tag: HOST_SOCKET_TAGS[1],
    limitKey: "maxCompositeSockets",
    display: true,
    protocol: OVERLAY_SOCKET_PROTOCOL,
  },
] as const satisfies readonly SocketDefinitionInput[];

const HUD_SOCKET_DEFINITIONS = [
  {
    tag: "overlay",
    limitKey: "maxOverlaySockets",
    display: true,
    protocol: OVERLAY_SOCKET_PROTOCOL,
  },
] as const satisfies readonly SocketDefinitionInput[];

const CHALLENGES_SOCKET_DEFINITIONS = [
  {
    tag: "challenge",
    limitKey: "maxChallengeSockets",
    display: true,
    protocol: OVERLAY_SOCKET_PROTOCOL,
  },
  {
    tag: "dock",
    limitKey: "maxDockSockets",
    display: true,
    protocol: DOCK_SOCKET_PROTOCOL,
  },
] as const satisfies readonly SocketDefinitionInput[];

export const SOCKET_DEFINITIONS = [
  HOST_SOCKET_DEFINITIONS[0],
  ...HUD_SOCKET_DEFINITIONS,
  HOST_SOCKET_DEFINITIONS[1],
  ...CHALLENGES_SOCKET_DEFINITIONS,
] as const satisfies readonly SocketDefinitionInput[];

export type SocketTag = (typeof SOCKET_DEFINITIONS)[number]["tag"];
export type SocketDefinition = (typeof SOCKET_DEFINITIONS)[number];
export type TokenSocketDefinition = Exclude<SocketDefinition, typeof HOST_SOCKET_DEFINITIONS[0]>;
export type TokenSocketTag = TokenSocketDefinition["tag"];

export type DockTokenMaterial = {
  token: string;
  tokenHash: string;
  tokenEnvelope: string;
};

export type ModuleActor = {
  twitchUserId: string;
  displayName: string;
};

export type ModuleSession = ModuleActor & {
  sessionHash: string;
};

/** Alle Anzeige-Sockets werden ueber das display-Flag der Registry bestimmt. */
export const DISPLAY_SOCKET_TAGS = SOCKET_DEFINITIONS
  .filter((definition) => definition.display)
  .map(({ tag }) => tag) as readonly SocketTag[];

/** Direkter Zugriff fuer Host-Code, ohne Tag-Literale in channel-object.ts. */
export const SOCKETS = {
  editor: HOST_SOCKET_DEFINITIONS[0],
  composite: HOST_SOCKET_DEFINITIONS[1],
  overlay: HUD_SOCKET_DEFINITIONS[0],
  challenge: CHALLENGES_SOCKET_DEFINITIONS[0],
  dock: CHALLENGES_SOCKET_DEFINITIONS[1],
} as const satisfies { [tag in SocketTag]: SocketDefinition };

export type ModuleContext = {
  sql: SqlStorage;
  transactionSync: <T>(fn: () => T) => T;
  actor: ModuleActor | null;
  now: () => string;
  releaseStage: "v1a" | "v1b";
  /** Schreibt den aktuellen Modulzustand in den Undo-Stapel. */
  recordHistory: (summary: string) => void;
  /** Wirft, wenn keine gültige Editor-Session anliegt. */
  requireSession: (request: Request) => ModuleSession;
  /** Session und CSRF in einem Schritt; die beiden treten nie getrennt auf. */
  requireSessionAndCsrf: (request: Request) => Promise<ModuleSession>;
  requireDockToken: (request: Request) => Promise<void>;
  /** Sendet an alle Sockets mit diesen Tags. */
  broadcast: (tags: readonly SocketTag[], payload: unknown) => void;
  /** Liest die aktuelle Dock-Token-Generation aus dem Host-Zustand. null bedeutet: kein Token. */
  /** Erzeugt Dock-Token-Material, ohne Pepper oder Kapsel-ID offenzulegen. */
  createDockTokenMaterial: () => Promise<DockTokenMaterial>;
  /** Entschlüsselt ein gespeichertes Dock-Token für eine Idempotenz-Wiederholung. */
  readDockTokenValue: (record: DockTokenRecord | null) => Promise<string | null>;
  /** Schließt alle Sockets mit diesem Tag. */
  revokeTokenSockets: (tag: SocketTag, expectedGeneration?: number) => void;
  /** Erstellt und persistiert Audit-Einträge über die Host-Plattform. */
  createAudit: (
    revision: number,
    action: AuditEntry["action"],
    actor: ModuleActor,
    summary: string,
    createdAt: string,
  ) => AuditEntry;
  insertAudit: (entry: AuditEntry) => void;
  pruneHistoryAndAudit: () => void;
  getUndoTargets: () => UndoTarget[];
  broadcastAudit: (entry: AuditEntry, undoTargets: UndoTarget[]) => void;
};

export type ModuleHandler = (request: Request, ctx: ModuleContext) => Promise<Response | null>;

export type ModuleHistoryEntry = {
  /** Modulinterne Revision. Nur das Modul deutet sie. */
  revision: number;
  /** Serialisierter Modulzustand. */
  json: string;
  /** Zeitpunkt des Zustands, ISO-8601. */
  createdAt: string;
};

export type ModuleHistory = {
  /** Liefert den aktuellen Zustand fuer den Undo-Stapel, oder null wenn es nichts zu sichern gibt. */
  snapshot: (ctx: ModuleContext) => ModuleHistoryEntry | null;
  /** Schreibt einen frueheren Zustand zurueck. */
  restore: (ctx: ModuleContext, json: string) => void;
  /** Erzeugt die unveränderte HUD-/Modulmeldung für einen Restore. */
  restoreSummary?: (ctx: ModuleContext, json: string, revision: number) => string;
  /** Liefert aus einem Snapshot die von der Host-Medienbereinigung zu schützenden Hashes. */
  mediaContentHashes?: (json: string) => readonly string[];
};

export type ModuleState = {
  ensure: (ctx: ModuleContext, actor: ModuleActor) => ChannelState;
  read: (ctx: ModuleContext) => ChannelState | null;
  getRequired: (ctx: ModuleContext) => ChannelState;
  write: (ctx: ModuleContext, state: ChannelState) => void;
  broadcast: (ctx: ModuleContext, state: ChannelState) => void;
};

/**
 * Tabellenbesitz als explizite Liste oder als Präfix. Ein reines Präfix
 * reicht nicht für jedes Modul: Die Host-Plattform trägt die querschnittlichen
 * historischen Namen (`state_history`, `audit_log`), das HUD selbst nur
 * `channel_state`.
 */
export type ModuleTables =
  | { kind: "prefix"; prefix: string }
  | { kind: "explicit"; tables: readonly string[] };

export type OverlayModuleDefinition = {
  id: string;
  /** DO-interne Routenpräfixe, z.B. ["/challenges"]. Nicht die öffentliche `/api/*`-Oberfläche. */
  routePrefixes: readonly string[];
  socketPaths: readonly string[];
  socketTags: readonly SocketTag[];
  socketDefinitions: readonly SocketDefinition[];
  tables: ModuleTables;
  wireScopes: readonly string[];
  migrationNamespace: string;
  handle?: ModuleHandler;
  history?: ModuleHistory;
  state?: ModuleState;
  /** Deklarations-Labels aus den Build-Budget-Definitionen. */
  budgetKeys: readonly string[];
};

/**
 * HUD: `ChannelState`, `readState`/`writeState`, modulbezogenes Undo. Sockets/Routen laut
 * `channel-object.ts` — `/ws/overlay` erhält nur `state_committed`
 * (`broadcastState`), nie Challenge-Updates. `/ws/editor` und `/ws/composite`
 * bedienen beide Module gemeinsam und gehören deshalb keinem der beiden
 * (Host-Plattform, siehe Selbsttest).
 */
const hudModuleDefinition = {
  id: "hud",
  routePrefixes: ["/state", "/overlay-visibility"],
  socketPaths: ["/ws/overlay"],
  socketTags: HUD_SOCKET_DEFINITIONS.map(({ tag }) => tag),
  socketDefinitions: HUD_SOCKET_DEFINITIONS,
  tables: {
    kind: "explicit",
    tables: ["channel_state"],
  },
  // Die HUD-Nachrichten (`state_committed`) tragen kein `scope`-Feld.
  wireScopes: [],
  migrationNamespace: "hud",
  budgetKeys: ["Overlay"],
} as const satisfies OverlayModuleDefinition;

const hudModule = {
  ...hudModuleDefinition,
  ...createHudModule([
    HOST_SOCKET_TAGS[0],
    ...HUD_SOCKET_DEFINITIONS.map(({ tag }) => tag),
    HOST_SOCKET_TAGS[1],
  ]),
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
  socketTags: CHALLENGES_SOCKET_DEFINITIONS.map(({ tag }) => tag),
  socketDefinitions: CHALLENGES_SOCKET_DEFINITIONS,
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
  handle: createChallengeHttpHandler(challengesModuleDefinition.socketTags, SOCKETS.dock.tag),
  history: challengeHistory,
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
