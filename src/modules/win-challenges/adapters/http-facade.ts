import type { ModuleContext, ModuleHandler, ModuleHistory, SocketTag } from "../../registry";
import { dockTokenResponseSchema, overlayTokenMutationRequestSchema } from "../../../shared/contracts/api";
import { jsonResponse, readJson, RequestError } from "../../../worker/http";
import {
  boardSaveRequestSchema,
  challengeSetDeleteResponseSchema,
  challengeSetListResponseSchema,
  challengeSetResponseSchema,
  challengeSetSaveRequestSchema,
  challengeBoardSnapshotSchema,
  commandSchema,
  settingsSaveRequestSchema,
  type Command,
} from "../contracts/schemas";
import { createWinChallenges, hashChallengeCommand } from "../service/commands";
import { createSqlStorageChallengeRepository } from "./sql-storage-challenge-repository";

const nowIso = (): string => new Date().toISOString();

const challengeRepository = (ctx: ModuleContext, dockSocketTag: SocketTag) =>
  createSqlStorageChallengeRepository({
    sql: ctx.sql,
    transactionSync: ctx.transactionSync,
    onDockTokenDeleted: () => {
      ctx.revokeTokenSockets(dockSocketTag);
    },
  });

export { challengeRepository };

const challengeService = (ctx: ModuleContext, dockSocketTag: SocketTag) =>
  createWinChallenges({
    repository: challengeRepository(ctx, dockSocketTag),
    clock: nowIso,
  });

export { challengeService };

const challengeHistoryRepository = (ctx: ModuleContext) =>
  createSqlStorageChallengeRepository({
    sql: ctx.sql,
    transactionSync: ctx.transactionSync,
  });

/** Die Challenges besitzen einen vollständigen Board-/Settings-Snapshot. */
export const challengeHistory: ModuleHistory = {
  snapshot: (ctx) => {
    const snapshot = challengeHistoryRepository(ctx).readSnapshot();
    return {
      revision: Math.max(snapshot.eventSeq, snapshot.boardRevision, snapshot.settingsRevision),
      json: JSON.stringify(snapshot),
      createdAt: nowIso(),
    };
  },
  restore: (ctx, json) => {
    let raw: unknown;
    try {
      raw = JSON.parse(json) as unknown;
    } catch {
      throw new Error("Challenge-Historiensnapshot ist kein gültiges JSON.");
    }
    challengeHistoryRepository(ctx).restoreSnapshot(challengeBoardSnapshotSchema.parse(raw));
  },
};

const challengeCommandSummary = (command: Command): string =>
  `Challenge-Kommando „${command.type}“ ausgeführt`;

/**
 * Lehnt Dock-Token für alle Set-Routen ab. Prüft KEINE Session — jede
 * Set-Route ruft danach zusätzlich `ctx.requireSession` oder
 * `ctx.requireSessionAndCsrf`. Der Name sagt genau das, damit niemand die
 * zweite Zeile für erledigt hält.
 */
const requireSetSession = (request: Request): void => {
  if (request.headers.get("x-dock-token") !== null) {
    throw new RequestError(403, "forbidden", "Der Dock darf keine Sets verwalten.");
  }
};

const decodeSetId = (setId: string): string => {
  if (setId === "" || setId.includes("/")) throw new RequestError(400, "bad_request", "Set-ID fehlt.");
  let decoded: string;
  try {
    decoded = decodeURIComponent(setId);
  } catch {
    throw new RequestError(400, "bad_request", "Set-ID ist ungültig.");
  }
  if (decoded === "" || decoded.includes("/")) throw new RequestError(400, "bad_request", "Set-ID ist ungültig.");
  return decoded;
};

const requireChallengeCommandAuth = async (
  request: Request,
  ctx: ModuleContext,
): Promise<"session" | "dock"> => {
  if (request.headers.get("x-dock-token") !== null) {
    await ctx.requireDockToken(request);
    return "dock";
  }
  await ctx.requireSessionAndCsrf(request);
  return "session";
};

const mutateDockToken = async (
  request: Request,
  ctx: ModuleContext,
  dockSocketTag: SocketTag,
  rotate: boolean,
): Promise<Response> => {
  const session = await ctx.requireSessionAndCsrf(request);
  const input = overlayTokenMutationRequestSchema.parse(await readJson(request, 2_048));
  const repository = challengeRepository(ctx, dockSocketTag);
  const current = repository.readDockToken();
  const currentGeneration = current?.generation ?? 0;
  if (
    current !== null &&
    current.generation === input.expectedGeneration + 1 &&
    current.requestId === input.requestId
  ) {
    if (current.creatingSessionHash !== session.sessionHash) {
      throw new RequestError(409, "idempotency_mismatch", "Token-Anfrage wurde anders wiederholt.");
    }
    const token = await ctx.readDockTokenValue(current);
    if (token === null) {
      throw new RequestError(409, "idempotency_mismatch", "Token-Anfrage kann nicht wiederhergestellt werden.");
    }
    if (rotate) ctx.revokeTokenSockets(dockSocketTag, input.expectedGeneration);
    return jsonResponse(
      dockTokenResponseSchema.parse({
        requestId: current.requestId,
        generation: current.generation,
        fingerprint: current.fingerprint,
        createdAt: current.createdAt,
        token,
      }),
    );
  }
  if (currentGeneration !== input.expectedGeneration || (rotate ? current === null : current !== null)) {
    throw new RequestError(409, "token_changed", "Der Dock-Tokenstatus hat sich geändert.");
  }
  const createdAt = nowIso();
  const generation = currentGeneration + 1;
  const material = await ctx.createDockTokenMaterial();
  // Zwischen dem ersten Lesen und hier liegt `await`. Ein paralleler Request
  // kann den Token inzwischen geändert haben, deshalb wird der Stand neu
  // gelesen — über dasselbe Repository wie oben, nicht über den Host.
  const currentAfterCrypto = repository.readDockToken();
  if (
    (currentAfterCrypto?.generation ?? 0) !== currentGeneration ||
    (rotate ? currentAfterCrypto === null : currentAfterCrypto !== null)
  ) {
    throw new RequestError(409, "token_changed", "Der Dock-Tokenstatus hat sich geändert.");
  }
  const fingerprint = material.tokenHash.slice(0, 8).toUpperCase();
  repository.upsertDockToken({
    tokenHash: material.tokenHash,
    tokenEnvelope: material.tokenEnvelope,
    fingerprint,
    generation,
    requestId: input.requestId,
    creatingSessionHash: session.sessionHash,
    createdAt,
    lastUsedAt: null,
  });
  if (rotate) ctx.revokeTokenSockets(dockSocketTag, currentGeneration);
  return jsonResponse(
    dockTokenResponseSchema.parse({
      requestId: input.requestId,
      generation,
      fingerprint,
      createdAt,
      token: material.token,
    }),
  );
};

/**
 * Erzeugt die Challenge-HTTP-Fassade. Die Socket-Tags kommen aus dem
 * Registry-Eintrag und werden nicht in der Geschäftslogik dupliziert.
 */
export const createChallengeHttpHandler = (
  socketTags: readonly SocketTag[],
  dockSocketTag: SocketTag,
): ModuleHandler =>
  async (request, ctx): Promise<Response | null> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/challenges") {
      ctx.requireSession(request);
      return jsonResponse(challengeService(ctx, dockSocketTag).readSnapshot());
    }
    if (request.method === "GET" && url.pathname === "/challenges/sets") {
      requireSetSession(request);
      ctx.requireSession(request);
      return jsonResponse(challengeSetListResponseSchema.parse({ sets: challengeService(ctx, dockSocketTag).listSets() }));
    }
    if (request.method === "POST" && url.pathname === "/challenges/sets") {
      requireSetSession(request);
      await ctx.requireSessionAndCsrf(request);
      const input = challengeSetSaveRequestSchema.parse(await readJson(request, 1_024));
      const record = challengeService(ctx, dockSocketTag).saveSet({
        name: input.name,
        includeProgress: input.includeProgress,
        ...(input.setId === undefined ? {} : { setId: input.setId }),
      });
      return jsonResponse(challengeSetResponseSchema.parse({ summary: record.summary, set: record.payload }));
    }
    if (request.method === "GET" && url.pathname.startsWith("/challenges/sets/")) {
      requireSetSession(request);
      ctx.requireSession(request);
      const decodedSetId = decodeSetId(url.pathname.slice("/challenges/sets/".length));
      const record = challengeService(ctx, dockSocketTag).readSet(decodedSetId);
      if (record === null) throw new RequestError(404, "not_found", "Set nicht gefunden.");
      return jsonResponse(challengeSetResponseSchema.parse({ summary: record.summary, set: record.payload }));
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/challenges/sets/")) {
      requireSetSession(request);
      await ctx.requireSessionAndCsrf(request);
      const decodedSetId = decodeSetId(url.pathname.slice("/challenges/sets/".length));
      challengeService(ctx, dockSocketTag).deleteSet(decodedSetId);
      return jsonResponse(challengeSetDeleteResponseSchema.parse({ id: decodedSetId, deleted: true }));
    }
    if (request.method === "POST" && url.pathname === "/challenges/commands") {
      const auth = await requireChallengeCommandAuth(request, ctx);
      const command = commandSchema.parse(await readJson(request, 32_768));
      if (auth === "dock" && command.scope === "global" && command.type === "resetGlobalTimer") {
        throw new RequestError(403, "forbidden", "Der Dock darf den globalen Timer nicht zurücksetzen.");
      }
      const requestHash = await hashChallengeCommand(command);
      const repository = challengeRepository(ctx, dockSocketTag);
      if (repository.readCommand(command.commandId) === null) ctx.recordHistory(challengeCommandSummary(command));
      const result = challengeService(ctx, dockSocketTag).executeCommandWithHash(command, requestHash);
      ctx.broadcast(socketTags, result.update);
      return jsonResponse(result.response);
    }
    if (request.method === "PUT" && url.pathname === "/challenges/board") {
      await ctx.requireSessionAndCsrf(request);
      const input = boardSaveRequestSchema.parse(await readJson(request, 32_768));
      ctx.recordHistory(input.reason === "set-switch" ? "Challenge-Set gewechselt" : "Challenge-Board gespeichert");
      const result = challengeService(ctx, dockSocketTag).saveBoard({
        baseBoardRevision: input.baseBoardRevision,
        definitions: input.challenges,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.setId === undefined ? {} : { setId: input.setId }),
      });
      ctx.broadcast(socketTags, {
        ...result.snapshot,
        event: input.reason === "set-switch"
          ? { scope: "board", type: "set_switched" }
          : null,
      });
      return jsonResponse(result);
    }
    if (request.method === "PUT" && url.pathname === "/challenges/settings") {
      await ctx.requireSessionAndCsrf(request);
      const input = settingsSaveRequestSchema.parse(await readJson(request, 32_768));
      ctx.recordHistory("Challenge-Einstellungen gespeichert");
      const result = challengeService(ctx, dockSocketTag).saveSettings(input);
      ctx.broadcast(socketTags, { ...result.snapshot, event: null });
      return jsonResponse(result);
    }
    if (request.method === "POST" && url.pathname === "/challenges/dock-token") {
      return mutateDockToken(request, ctx, dockSocketTag, false);
    }
    if (request.method === "POST" && url.pathname === "/challenges/dock-token/rotate") {
      return mutateDockToken(request, ctx, dockSocketTag, true);
    }
    return null;
  };
