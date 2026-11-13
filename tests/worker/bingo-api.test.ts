import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/channel/migrations";
import type { BingoBoardState } from "../../src/modules/bingo/contracts/schemas";
import { MAX_BINGO_FILE_BYTES } from "../../src/modules/bingo/domain/card-codec";
import { bootstrapResponseSchema, dockTokenResponseSchema } from "../../src/shared/contracts/api";

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

const refreshCsrf = async () => {
  const response = await fetchWorker("/api/editor/bootstrap", { headers: { cookie, "x-editor-tab": tabId } });
  const bootstrap = bootstrapResponseSchema.parse(await response.json());
  csrfToken = bootstrap.csrfToken;
  return bootstrap;
};

const rotateDockToken = async (): Promise<string> => {
  const bootstrap = await refreshCsrf();
  const hasToken = bootstrap.capsule.dockToken?.exists === true;
  const response = await fetchWorker(`/api/challenges/dock-token${hasToken ? "/rotate" : ""}`, {
    method: "POST",
    headers: authenticatedHeaders(),
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      expectedGeneration: bootstrap.capsule.dockToken?.generation ?? 0,
    }),
  });
  expect(response.status).toBe(200);
  return dockTokenResponseSchema.parse(await response.json()).token;
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

  it("erlaubt dem Dock nur Board-Lesen, Markieren und Zurücksetzen und weist andere Routen ab", async () => {
    const token = await rotateDockToken();
    const dockHeaders = { authorization: `Bearer ${token}`, origin, "content-type": "application/json" };
    const initial = await fetchWorker("/api/bingo/dock", { headers: dockHeaders });
    expect(initial.status).toBe(200);
    const initialBoard = await initial.json<BingoBoardState>();
    const firstCell = initialBoard.card.cells[0];
    if (firstCell === undefined) throw new Error("Bingo-Feld fehlt.");

    const marked = await fetchWorker("/api/bingo/dock/mark", {
      method: "POST",
      headers: dockHeaders,
      body: JSON.stringify({ cellId: firstCell.id, marked: true, expectedMarkRevision: initialBoard.markRevision }),
    });
    expect(marked.status).toBe(200);
    const markedResult = await marked.json<{
      board: BingoBoardState;
      auditEntry: { actor: { displayName: string } } | null;
    }>();
    expect(markedResult.board.marks).toEqual([firstCell.id]);
    expect(markedResult.auditEntry?.actor.displayName).toBe("Dock");

    const unmarked = await fetchWorker("/api/bingo/dock/mark", {
      method: "POST",
      headers: dockHeaders,
      body: JSON.stringify({ cellId: firstCell.id, marked: false, expectedMarkRevision: markedResult.board.markRevision }),
    });
    expect(unmarked.status).toBe(200);
    const unmarkedBoard = await unmarked.json<{ board: BingoBoardState }>();
    expect(unmarkedBoard.board.marks).toEqual([]);

    await fetchWorker("/api/bingo/dock/mark", {
      method: "POST",
      headers: dockHeaders,
      body: JSON.stringify({ cellId: firstCell.id, marked: true, expectedMarkRevision: unmarkedBoard.board.markRevision }),
    });
    const reset = await fetchWorker("/api/bingo/dock/reset", {
      method: "POST",
      headers: dockHeaders,
      body: JSON.stringify({ expectedMarkRevision: unmarkedBoard.board.markRevision + 1 }),
    });
    expect(reset.status).toBe(200);
    expect((await reset.json<{ board: BingoBoardState }>()).board.marks).toEqual([]);

    const forbiddenRoutes: Array<[string, string, string?]> = [
      ["GET", "/api/bingo"],
      ["GET", "/api/bingo/sets"],
      ["POST", "/api/bingo/sets", JSON.stringify({ name: "Dock-Set" })],
      ["PATCH", "/api/bingo/sets/owned-set", JSON.stringify({ name: "Dock-Set" })],
      ["GET", "/api/bingo/sets/template-crashout"],
      ["DELETE", "/api/bingo/sets/owned-set"],
      ["POST", "/api/bingo/sets/owned-set/load", JSON.stringify({ expectedCardRevision: 0 })],
      ["POST", "/api/bingo/mark", JSON.stringify({ cellId: firstCell.id, marked: true, expectedMarkRevision: 0 })],
      ["POST", "/api/bingo/reset", JSON.stringify({ expectedMarkRevision: 0 })],
      ["PUT", "/api/bingo/board", JSON.stringify({})],
      ["PUT", "/api/bingo/style", JSON.stringify({})],
      ["GET", "/api/bingo/export"],
      ["POST", "/api/bingo/import", JSON.stringify({})],
      ["POST", "/api/state/undo", JSON.stringify({ moduleId: "bingo" })],
    ];
    for (const [method, path, body] of forbiddenRoutes) {
      const response = await fetchWorker(path, {
        method,
        headers: dockHeaders,
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }

    const wrongToken = await fetchWorker("/api/bingo/dock", {
      headers: { authorization: `Bearer ${"x".repeat(43)}`, origin },
    });
    expect(wrongToken.status).toBe(403);

    const revokedToken = token;
    await rotateDockToken();
    const revokedRequest = await fetchWorker("/api/bingo/dock/mark", {
      method: "POST",
      headers: { ...dockHeaders, authorization: `Bearer ${revokedToken}` },
      body: JSON.stringify({ cellId: firstCell.id, marked: true, expectedMarkRevision: 3 }),
    });
    expect(revokedRequest.status).toBe(403);
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

  it("weist nach Undo einen Stilwechsel mit der Revision davor zurück", async () => {
    const styled = await fetchWorker("/api/bingo/style", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ style: "broadcast", expectedCardRevision: 0 }),
    });
    expect(styled.status).toBe(200);
    const afterStyle = await readBingo();
    const bootstrapResponse = await fetchWorker("/api/editor/bootstrap", {
      headers: { cookie, "x-editor-tab": tabId },
    });
    const bootstrap = bootstrapResponseSchema.parse(await bootstrapResponse.json());
    const target = bootstrap.bingoUndoTargets[0];
    if (target === undefined) throw new Error("Bingo-Undo-Ziel fehlt.");

    const undo = await fetchWorker("/api/state/undo", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        moduleId: "bingo",
        channelSeq: target.channelSeq,
        baseCardRevision: afterStyle.cardRevision,
        baseMarkRevision: afterStyle.markRevision,
        baseGeneration: afterStyle.generation,
        baseStyle: afterStyle.style,
        baseSettingsRevision: afterStyle.settingsRevision,
      }),
    });
    expect(undo.status).toBe(200);
    expect((await readBingo()).style).toBe("marker");

    const staleStyle = await fetchWorker("/api/bingo/style", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ style: "broadcast", expectedCardRevision: afterStyle.cardRevision }),
    });

    expect(staleStyle.status).toBe(409);
    await expect(staleStyle.json()).resolves.toMatchObject({
      error: { code: "revision_conflict", currentSnapshot: { style: "marker", cardRevision: afterStyle.cardRevision + 1 } },
    });
  });

  it("lehnt das Löschen einer Vorlage ab und löscht eigene Sets weiterhin", async () => {
    const list = await fetchWorker("/api/bingo/sets", { headers: authenticatedHeaders() });
    const sets = await list.json<{ sets: { id: string; type: "template" | "user" }[] }>();
    const template = sets.sets.find(({ type }) => type === "template");
    if (template === undefined) throw new Error("Bingo-Vorlage fehlt.");

    const templateDelete = await fetchWorker(`/api/bingo/sets/${template.id}`, {
      method: "DELETE",
      headers: authenticatedHeaders(),
    });
    expect(templateDelete.status).toBe(422);
    await expect(templateDelete.json()).resolves.toMatchObject({
      error: { code: "validation_failed", message: "Bingo-Vorlagen können nicht gelöscht werden." },
    });

    const saved = await fetchWorker("/api/bingo/sets", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ name: "Eigenes Set" }),
    });
    const savedBody = await saved.json<{ summary: { id: string; type: string } }>();
    expect(savedBody.summary.type).toBe("user");
    const userDelete = await fetchWorker(`/api/bingo/sets/${savedBody.summary.id}`, {
      method: "DELETE",
      headers: authenticatedHeaders(),
    });
    expect(userDelete.status).toBe(200);
  });

  it("benennt eigene Bingo-Sets und Vorlagen um und lehnt normalisierte Namenskonflikte ab", async () => {
    const created = await fetchWorker("/api/bingo/sets", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ name: "Abendkarte" }),
    });
    const createdBody = await created.json<{ summary: { id: string; name: string } }>();

    const renamed = await fetchWorker(`/api/bingo/sets/${createdBody.summary.id}`, {
      method: "PATCH",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ name: "  Neue Karte  " }),
    });
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({ summary: { id: createdBody.summary.id, name: "Neue Karte", type: "user" } });
    const audit = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ summary: string }>(
      "SELECT summary FROM audit_log WHERE summary = ? ORDER BY created_at DESC LIMIT 1",
      "Bingo-Set „Neue Karte“ umbenannt",
    ).toArray()[0]?.summary);
    expect(audit).toBe("Bingo-Set „Neue Karte“ umbenannt");

    const secondSet = await fetchWorker("/api/bingo/sets", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ name: "Zweite Karte" }),
    });
    const secondSetBody = await secondSet.json<{ summary: { id: string } }>();

    const duplicate = await fetchWorker(`/api/bingo/sets/${secondSetBody.summary.id}`, {
      method: "PATCH",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ name: "neue karte" }),
    });
    expect(duplicate.status).toBe(422);
    await expect(duplicate.json()).resolves.toMatchObject({ error: { code: "validation_failed" } });

    const list = await fetchWorker("/api/bingo/sets", { headers: authenticatedHeaders() });
    const sets = await list.json<{ sets: { id: string; name: string; type: string }[] }>();
    expect(sets.sets).toContainEqual(expect.objectContaining({ id: createdBody.summary.id, name: "Neue Karte", type: "user" }));
    const template = sets.sets.find((set) => set.type === "template" && set.name === "Gaming-Fails");
    if (template === undefined) throw new Error("Umbenannte Bingo-Vorlage fehlt.");
    const otherTemplate = sets.sets.find((set) => set.type === "template" && set.id !== template.id);
    if (otherTemplate === undefined) throw new Error("Weitere Bingo-Vorlage fehlt.");
    const duplicateTemplate = await fetchWorker(`/api/bingo/sets/${otherTemplate.id}`, {
      method: "PATCH",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ name: "gaming-fails" }),
    });
    expect(duplicateTemplate.status).toBe(422);

    const renamedTemplate = await fetchWorker(`/api/bingo/sets/${template.id}`, {
      method: "PATCH",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ name: "Gaming-Abend" }),
    });
    expect(renamedTemplate.status).toBe(200);
    await expect(renamedTemplate.json()).resolves.toMatchObject({
      summary: { id: template.id, name: "Gaming-Abend", type: "template" },
      card: { title: "Gaming-Abend" },
    });
    const restoredTemplate = await fetchWorker(`/api/bingo/sets/${template.id}`, {
      method: "PATCH",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ name: "Gaming-Fails" }),
    });
    expect(restoredTemplate.status).toBe(200);
  });

  it("überschreibt ein eigenes Set nur mit gesetzter Ziel-ID und lehnt Vorlagen ab", async () => {
    const initial = await fetchWorker("/api/bingo/sets", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ name: "Wiederverwenden" }),
    });
    const initialBody = await initial.json<{ summary: { id: string } }>();

    const savedCard = await saveCard(card("Neue Bingo-Karte", "overwrite"), 0);
    expect(savedCard.status).toBe(200);

    const overwritten = await fetchWorker("/api/bingo/sets", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ name: "Wiederverwenden", overwriteSetId: initialBody.summary.id }),
    });
    expect(overwritten.status).toBe(200);
    await expect(overwritten.json()).resolves.toMatchObject({
      summary: { id: initialBody.summary.id, name: "Wiederverwenden", type: "user" },
      card: { title: "Neue Bingo-Karte" },
    });

    const template = (await (await fetchWorker("/api/bingo/sets", { headers: authenticatedHeaders() })).json<{
      sets: { id: string; name: string; type: string }[];
    }>()).sets.find((set) => set.type === "template" && set.name === "Gaming-Fails");
    if (template === undefined) throw new Error("Bingo-Vorlage fehlt.");
    const templateOverwrite = await fetchWorker("/api/bingo/sets", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ name: template.name }),
    });
    expect(templateOverwrite.status).toBe(422);
    const templateOverwriteBody = await templateOverwrite.json<{ error: { code: string; message: string } }>();
    expect(templateOverwriteBody.error.code).toBe("validation_failed");
    expect(templateOverwriteBody.error.message).toMatch(/Vorlage.*nicht überschrieben/i);
  });

  it("saves, styles, lists and loads cards independently, keeping presentation settings out of portable files", async () => {
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

    const beforeSettings = await readBingo();
    const settings = await fetchWorker("/api/bingo/settings", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        baseSettingsRevision: beforeSettings.settingsRevision,
        settings: { ...beforeSettings.settings, showTitle: false },
      }),
    });
    expect(settings.status).toBe(200);
    const presentation = await readBingo();

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
    expect(JSON.parse(file)).toEqual({
      format: "questframe-bingo",
      version: 1,
      card: savedSetBody.card,
    });
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
    expect(importedBoard.settings).toEqual(presentation.settings);
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
