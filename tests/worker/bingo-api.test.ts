import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/channel/migrations";
import type { BingoBoardState } from "../../src/modules/bingo/contracts/schemas";
import { MAX_BINGO_FILE_BYTES } from "../../src/modules/bingo/domain/card-codec";
import { bootstrapResponseSchema } from "../../src/shared/contracts/api";

const origin = "http://localhost:5173";
const tabId = "bingo-api-test";
const stub = env.CHANNEL.get(env.CHANNEL.idFromName(`channel:${env.BROADCASTER_ID}`));

let cookie = "";
let csrfToken = "";

const fetchWorker = (path: string, init?: RequestInit): Promise<Response> =>
  exports.default.fetch(new Request(`http://localhost${path}`, init));

const authenticatedHeaders = (): HeadersInit => ({
  cookie,
  origin,
  "x-editor-tab": tabId,
  "x-csrf-token": csrfToken,
  "content-type": "application/json",
});

const card = (title = "Testkarte", prefix = "test"): Pick<BingoBoardState["card"], "title" | "size" | "cells"> => ({
  title,
  size: 3,
  cells: Array.from({ length: 9 }, (_, index) => ({ id: `${prefix}-${String(index)}`, text: `Feld ${String(index)}` })),
});

const refreshCsrf = async (): Promise<void> => {
  const response = await fetchWorker("/api/editor/bootstrap", { headers: { cookie, "x-editor-tab": tabId } });
  csrfToken = bootstrapResponseSchema.parse(await response.json()).csrfToken;
};

const readBingo = async (): Promise<BingoBoardState> => {
  const response = await fetchWorker("/api/bingo", { headers: authenticatedHeaders() });
  expect(response.status).toBe(200);
  return response.json<BingoBoardState>();
};

const saveCard = (body: ReturnType<typeof card>, expectedCardRevision: number) =>
  fetchWorker("/api/bingo/board", {
    method: "PUT",
    headers: authenticatedHeaders(),
    body: JSON.stringify({ ...body, placement: { x: 8, y: 8, scale: 1 }, expectedCardRevision }),
  });

describe("Bingo-API", () => {
  beforeAll(async () => {
    const login = await fetchWorker("/auth/dev", { redirect: "manual" });
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  });

  beforeEach(async () => {
    await runInDurableObject(stub, (_instance, state) => {
      runMigrations(state.storage.sql, "worker-test-bingo-api");
      state.storage.sql.exec("DELETE FROM state_history WHERE module_id = 'bingo'");
      state.storage.sql.exec("DELETE FROM bg_sets WHERE type = 'user'");
      state.storage.sql.exec(
        `UPDATE bg_board SET marks_json = '[]', card_revision = 0, mark_revision = 0,
          generation = 0, style = 'marker', placement_x = 8, placement_y = 8, placement_scale = 1
         WHERE singleton = 1`,
      );
    });
    await refreshCsrf();
  });

  it("reads the board and rejects missing or ineligible editor sessions", async () => {
    const unauthenticated = await fetchWorker("/api/bingo", { headers: { origin } });
    expect(unauthenticated.status).toBe(401);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE editor_sessions SET role_checked_at = '2000-01-01T00:00:00.000Z'");
    });
    const ineligible = await fetchWorker("/api/bingo", { headers: { cookie, origin, "x-editor-tab": tabId } });
    expect(ineligible.status).toBe(403);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE editor_sessions SET role_checked_at = ?", new Date().toISOString());
    });

    const board = await readBingo();
    expect(board.card.cells).toHaveLength(board.card.size ** 2);
    expect(board.marks).toEqual([]);
  });

  it("marks and resets with revision conflicts in the challenge error shape", async () => {
    const challengesBefore = await (await fetchWorker("/api/challenges", { headers: authenticatedHeaders() })).json();
    const saved = await saveCard(card(), 0);
    expect(saved.status).toBe(200);
    const board = await readBingo();
    const marked = await fetchWorker("/api/bingo/mark", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ cellId: "test-0", marked: true, expectedMarkRevision: board.markRevision }),
    });
    expect(marked.status).toBe(200);
    expect((await readBingo()).marks).toEqual(["test-0"]);

    const stale = await fetchWorker("/api/bingo/mark", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ cellId: "test-1", marked: true, expectedMarkRevision: board.markRevision }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "revision_conflict", currentSnapshot: { markRevision: board.markRevision + 1 } },
    });

    const reset = await fetchWorker("/api/bingo/reset", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ expectedMarkRevision: board.markRevision + 1 }),
    });
    expect(reset.status).toBe(200);
    expect((await readBingo()).marks).toEqual([]);
    const challengesAfter = await (await fetchWorker("/api/challenges", { headers: authenticatedHeaders() })).json();
    expect(challengesAfter).toEqual(challengesBefore);
  });

  it("saves, styles, lists, loads, exports and imports cards independently of challenges", async () => {
    const challengesBefore = await (await fetchWorker("/api/challenges", { headers: authenticatedHeaders() })).json();
    expect((await saveCard(card(), 0)).status).toBe(200);

    const style = await fetchWorker("/api/bingo/style", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ style: "broadcast", expectedCardRevision: 1 }),
    });
    expect(style.status).toBe(200);
    const first = await readBingo();
    expect(first.style).toBe("broadcast");
    expect(first.cardRevision).toBe(2);

    const staleStyle = await fetchWorker("/api/bingo/style", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ style: "marker", expectedCardRevision: 1 }),
    });
    expect(staleStyle.status).toBe(409);
    await expect(staleStyle.json()).resolves.toMatchObject({
      error: { code: "revision_conflict", currentSnapshot: { style: "broadcast", cardRevision: 2 } },
    });

    const savedSet = await fetchWorker("/api/bingo/sets", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ name: "Geteilt" }),
    });
    expect(savedSet.status).toBe(200);
    const savedSetBody = await savedSet.json<{ summary: { id: string }; card: BingoBoardState["card"] }>();
    const listed = await fetchWorker("/api/bingo/sets", { headers: authenticatedHeaders() });
    expect((await listed.json<{ sets: { id: string }[] }>()).sets).toContainEqual(
      expect.objectContaining({ id: savedSetBody.summary.id }),
    );

    const fileResponse = await fetchWorker("/api/bingo/export", { headers: authenticatedHeaders() });
    expect(fileResponse.status).toBe(200);
    const file = await fileResponse.text();
    const changed = await saveCard(card("Andere Karte", "other"), first.cardRevision);
    expect(changed.status).toBe(200);
    const beforeImport = await readBingo();
    await fetchWorker("/api/bingo/mark", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ cellId: "other-0", marked: true, expectedMarkRevision: beforeImport.markRevision }),
    });
    const current = await readBingo();
    const imported = await fetchWorker("/api/bingo/import", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ file, expectedCardRevision: current.cardRevision }),
    });
    expect(imported.status).toBe(200);
    const importedBoard = await readBingo();
    expect(importedBoard.card).toEqual(savedSetBody.card);
    expect(importedBoard.marks).toEqual([]);
    expect(importedBoard.generation).toBe(current.generation + 1);

    const load = await fetchWorker(`/api/bingo/sets/${savedSetBody.summary.id}/load`, {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ expectedCardRevision: importedBoard.cardRevision }),
    });
    expect(load.status).toBe(200);
    const deleted = await fetchWorker(`/api/bingo/sets/${savedSetBody.summary.id}`, {
      method: "DELETE",
      headers: authenticatedHeaders(),
    });
    expect(deleted.status).toBe(200);

    const challengesAfter = await (await fetchWorker("/api/challenges", { headers: authenticatedHeaders() })).json();
    expect(challengesAfter).toEqual(challengesBefore);
  });

  it("imports a file under the file cap when its JSON envelope needs escaping", async () => {
    const escapedCard = {
      format: "questframe-bingo",
      version: 1,
      card: {
        title: "Anführungszeichen",
        size: 3,
        cells: Array.from({ length: 9 }, (_, index) => ({
          id: `quote-${String(index)}`,
          text: '"'.repeat(40),
        })),
      },
    };
    const serializedFile = JSON.stringify(escapedCard, null, 2);
    const serializedFileBytes = new TextEncoder().encode(serializedFile).byteLength;
    const padding = "\n".repeat(MAX_BINGO_FILE_BYTES - 1 - serializedFileBytes);
    const file = `${padding}${serializedFile}`;
    const envelope = JSON.stringify({ file, expectedCardRevision: 0 });
    expect(new TextEncoder().encode(file).byteLength).toBe(MAX_BINGO_FILE_BYTES - 1);
    expect(new TextEncoder().encode(envelope).byteLength).toBeGreaterThan(20_000);
    expect(new TextEncoder().encode(envelope).byteLength).toBeLessThanOrEqual(2 * MAX_BINGO_FILE_BYTES + 1_024);

    const response = await fetchWorker("/api/bingo/import", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: envelope,
    });

    expect(response.status).toBe(200);
    expect((await readBingo()).card.title).toBe("Anführungszeichen");
  });
});
