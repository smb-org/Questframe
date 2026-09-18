import type { ModuleContext, ModuleHandler } from "../../registry";
import { jsonResponse, readJson, RequestError } from "../../../worker/http";
import {
  boardSaveRequestSchema,
  challengeSetDeleteResponseSchema,
  challengeSetListResponseSchema,
  challengeSetResponseSchema,
  challengeSetSaveRequestSchema,
  commandSchema,
  settingsSaveRequestSchema,
} from "../contracts/schemas";
import { createWinChallenges } from "../service/commands";
import { createSqlStorageChallengeRepository } from "./sql-storage-challenge-repository";

const nowIso = (): string => new Date().toISOString();

const challengeRepository = (ctx: ModuleContext) =>
  createSqlStorageChallengeRepository({
    sql: ctx.sql,
    transactionSync: ctx.transactionSync,
    onDockTokenDeleted: () => {
      ctx.revokeTokenSockets("dock");
    },
  });

export { challengeRepository };

const challengeService = (ctx: ModuleContext) =>
  createWinChallenges({
    repository: challengeRepository(ctx),
    clock: nowIso,
  });

export { challengeService };

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

/**
 * Erzeugt die Challenge-HTTP-Fassade. Die Socket-Tags kommen aus dem
 * Registry-Eintrag und werden nicht in der Geschäftslogik dupliziert.
 */
export const createChallengeHttpHandler = (socketTags: readonly string[]): ModuleHandler =>
  async (request, ctx): Promise<Response | null> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/challenges") {
      ctx.requireSession(request);
      return jsonResponse(challengeService(ctx).readSnapshot());
    }
    if (request.method === "GET" && url.pathname === "/challenges/sets") {
      requireSetSession(request);
      ctx.requireSession(request);
      return jsonResponse(challengeSetListResponseSchema.parse({ sets: challengeService(ctx).listSets() }));
    }
    if (request.method === "POST" && url.pathname === "/challenges/sets") {
      requireSetSession(request);
      await ctx.requireSessionAndCsrf(request);
      const input = challengeSetSaveRequestSchema.parse(await readJson(request, 1_024));
      const record = challengeService(ctx).saveSet({
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
      const record = challengeService(ctx).readSet(decodedSetId);
      if (record === null) throw new RequestError(404, "not_found", "Set nicht gefunden.");
      return jsonResponse(challengeSetResponseSchema.parse({ summary: record.summary, set: record.payload }));
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/challenges/sets/")) {
      requireSetSession(request);
      await ctx.requireSessionAndCsrf(request);
      const decodedSetId = decodeSetId(url.pathname.slice("/challenges/sets/".length));
      challengeService(ctx).deleteSet(decodedSetId);
      return jsonResponse(challengeSetDeleteResponseSchema.parse({ id: decodedSetId, deleted: true }));
    }
    if (request.method === "POST" && url.pathname === "/challenges/commands") {
      const auth = await requireChallengeCommandAuth(request, ctx);
      const command = commandSchema.parse(await readJson(request, 32_768));
      if (auth === "dock" && command.scope === "global" && command.type === "resetGlobalTimer") {
        throw new RequestError(403, "forbidden", "Der Dock darf den globalen Timer nicht zurücksetzen.");
      }
      const result = await challengeService(ctx).executeCommand(command);
      ctx.broadcast(socketTags, result.update);
      return jsonResponse(result.response);
    }
    if (request.method === "PUT" && url.pathname === "/challenges/board") {
      await ctx.requireSessionAndCsrf(request);
      const input = boardSaveRequestSchema.parse(await readJson(request, 32_768));
      const result = challengeService(ctx).saveBoard({
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
      const result = challengeService(ctx).saveSettings(input);
      ctx.broadcast(socketTags, { ...result.snapshot, event: null });
      return jsonResponse(result);
    }

    // Die Dock-Token-Routen bleiben beim Host, weil sie gemeinsamen Token-Zustand ändern.
    return null;
  };
