import type { ModuleContext, ModuleHandler, ModuleHistory, ModuleActor, ModuleSession, SocketTag } from "../../registry";
import { errorResponse, jsonResponse, readJson, RequestError } from "../../../worker/http";
import {
  bingoCardSaveRequestSchema,
  bingoImportRequestSchema,
  bingoSetDeleteResponseSchema,
  bingoSetListResponseSchema,
  bingoSetLoadRequestSchema,
  bingoSetResponseSchema,
  bingoSetSaveRequestSchema,
  bingoStyleRequestSchema,
  bingoBoardStateSchema,
  markCellPayloadSchema,
  resetMarksPayloadSchema,
} from "../contracts/schemas";
import { decodeBingoCard, encodeBingoCard, MAX_BINGO_FILE_BYTES } from "../domain/card-codec";
import { applyBingoUndo, createBingoService, type BingoCommandResult } from "../service/commands";
import {
  BingoNotFoundError,
  BingoRepositoryError,
  createSqlStorageBingoRepository,
} from "../repository/bingo-repository";

const fallbackActor: ModuleActor = { twitchUserId: "0", displayName: "Questframe" };

export const bingoRepository = (ctx: ModuleContext) => createSqlStorageBingoRepository({
  sql: ctx.sql,
  transactionSync: ctx.transactionSync,
});

const bingoService = (ctx: ModuleContext, actor: ModuleActor = ctx.actor ?? fallbackActor) =>
  createBingoService({
    repository: bingoRepository(ctx),
    actor: { twitchUserId: actor.twitchUserId, displayName: actor.displayName },
    clock: ctx.now,
  });

const requireEditorSession = (request: Request, ctx: ModuleContext): ModuleSession => {
  if (request.headers.get("x-dock-token") !== null) {
    throw new RequestError(403, "forbidden", "Der Dock darf Bingo nicht verwalten.");
  }
  return ctx.requireSession(request);
};

const requireEditorMutation = (request: Request, ctx: ModuleContext): Promise<ModuleSession> => {
  if (request.headers.get("x-dock-token") !== null) {
    throw new RequestError(403, "forbidden", "Der Dock darf Bingo nicht verwalten.");
  }
  return ctx.requireSessionAndCsrf(request);
};

const decodeSetId = (value: string): string => {
  if (value === "" || value.includes("/")) throw new RequestError(400, "bad_request", "Bingo-Set-ID fehlt.");
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new RequestError(400, "bad_request", "Bingo-Set-ID ist ungültig.");
  }
  if (decoded === "" || decoded.includes("/")) throw new RequestError(400, "bad_request", "Bingo-Set-ID ist ungültig.");
  return decoded;
};

const mutationResponse = (
  ctx: ModuleContext,
  socketTags: readonly SocketTag[],
  result: BingoCommandResult,
): Response => {
  if (result.update !== null) ctx.broadcast(socketTags, result.update);
  if (result.auditEntry !== null) ctx.broadcastAudit(result.auditEntry, ctx.getUndoTargets());
  return jsonResponse({ ...result, undoTargets: ctx.getUndoTargets(), serverTime: ctx.now() });
};

export const bingoHistory: ModuleHistory = {
  snapshot: (ctx) => {
    const board = bingoRepository(ctx).readBoard();
    return {
      revision: Math.max(board.cardRevision, board.markRevision),
      json: JSON.stringify(board),
      createdAt: ctx.now(),
    };
  },
  restore: (ctx, json) => {
    let raw: unknown;
    try {
      raw = JSON.parse(json) as unknown;
    } catch {
      throw new Error("Bingo-Historiensnapshot ist kein gültiges JSON.");
    }
    const parsedTarget = bingoBoardStateSchema.parse(raw);
    bingoRepository(ctx).transaction((transaction) => {
      transaction.writeBoard(parsedTarget, ctx.now());
    });
  },
};

export const createBingoHttpHandler = (socketTags: readonly SocketTag[]): ModuleHandler =>
  async (request, ctx): Promise<Response | null> => {
    const url = new URL(request.url);
    const repository = bingoRepository(ctx);

    if (request.method === "GET" && url.pathname === "/bingo") {
      requireEditorSession(request, ctx);
      return jsonResponse(bingoService(ctx).readBoard());
    }
    if (request.method === "GET" && url.pathname === "/bingo/sets") {
      requireEditorSession(request, ctx);
      return jsonResponse(bingoSetListResponseSchema.parse({ sets: repository.listSets() }));
    }
    if (request.method === "POST" && url.pathname === "/bingo/sets") {
      const session = await requireEditorMutation(request, ctx);
      const input = bingoSetSaveRequestSchema.parse(await readJson(request, 2_048));
      const record = bingoService(ctx, session).saveSet(input.name);
      return jsonResponse(bingoSetResponseSchema.parse({ summary: record.summary, card: record.card }));
    }
    if (request.method === "POST" && url.pathname === "/bingo/mark") {
      const session = await requireEditorMutation(request, ctx);
      const parsed = markCellPayloadSchema.parse(await readJson(request, 4_096));
      const result = bingoService(ctx, session).markCell(parsed.cellId, parsed.marked, parsed.expectedMarkRevision);
      return mutationResponse(ctx, socketTags, result);
    }
    if (request.method === "POST" && url.pathname === "/bingo/reset") {
      const session = await requireEditorMutation(request, ctx);
      const input = resetMarksPayloadSchema.parse(await readJson(request, 2_048));
      return mutationResponse(ctx, socketTags, bingoService(ctx, session).resetMarks(input.expectedMarkRevision));
    }
    if (request.method === "PUT" && url.pathname === "/bingo/board") {
      const session = await requireEditorMutation(request, ctx);
      const input = bingoCardSaveRequestSchema.parse(await readJson(request, 32_768));
      const { expectedCardRevision, ...card } = input;
      return mutationResponse(ctx, socketTags, bingoService(ctx, session).saveCard({ ...card, expectedCardRevision }));
    }
    if (request.method === "PUT" && url.pathname === "/bingo/style") {
      const session = await requireEditorMutation(request, ctx);
      const input = bingoStyleRequestSchema.parse(await readJson(request, 2_048));
      return mutationResponse(ctx, socketTags, bingoService(ctx, session).setStyle(input.style));
    }
    if (request.method === "GET" && url.pathname === "/bingo/export") {
      requireEditorSession(request, ctx);
      const card = bingoService(ctx).readBoard().card;
      return new Response(encodeBingoCard(card), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${encodeURIComponent(card.title)}.bingo.json"`,
          "cache-control": "private, no-store",
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/bingo/import") {
      const session = await requireEditorMutation(request, ctx);
      const input = bingoImportRequestSchema.parse(await readJson(request, 2 * MAX_BINGO_FILE_BYTES + 1_024));
      const decoded = decodeBingoCard(input.file);
      if (!decoded.ok) throw new RequestError(422, "validation_failed", decoded.error.message);
      const result = bingoService(ctx, session).importCard(decoded.value, input.expectedCardRevision);
      return mutationResponse(ctx, socketTags, result);
    }
    if (request.method === "POST" && url.pathname.startsWith("/bingo/sets/") && url.pathname.endsWith("/load")) {
      const session = await requireEditorMutation(request, ctx);
      const setId = decodeSetId(url.pathname.slice("/bingo/sets/".length, -"/load".length));
      const input = bingoSetLoadRequestSchema.parse(await readJson(request, 2_048));
      return mutationResponse(ctx, socketTags, bingoService(ctx, session).loadSet(setId, input.expectedCardRevision));
    }
    if (request.method === "GET" && url.pathname.startsWith("/bingo/sets/")) {
      requireEditorSession(request, ctx);
      const setId = decodeSetId(url.pathname.slice("/bingo/sets/".length));
      const record = repository.getSet(setId);
      if (record === null) throw new BingoNotFoundError();
      return jsonResponse(bingoSetResponseSchema.parse({ summary: record.summary, card: record.card }));
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/bingo/sets/")) {
      const session = await requireEditorMutation(request, ctx);
      const setId = decodeSetId(url.pathname.slice("/bingo/sets/".length));
      bingoService(ctx, session).deleteSet(setId);
      return jsonResponse(bingoSetDeleteResponseSchema.parse({ id: setId, deleted: true }));
    }
    return null;
  };

export { applyBingoUndo };

export const mapBingoError = (error: unknown): Response | null => {
  if (!(error instanceof BingoRepositoryError)) return null;
  const status = error.code === "not_found" ? 404 : error.code === "revision_conflict" ? 409 : 422;
  const details = error.code === "revision_conflict" && "board" in error
    ? { currentSnapshot: error.board }
    : {};
  return errorResponse(status, error.code, error.message, details);
};
