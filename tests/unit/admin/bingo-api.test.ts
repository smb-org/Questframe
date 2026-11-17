import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserAdminApi } from "../../../src/admin/api";
import type {
  BingoBoardState,
  BingoMutationResponse,
  BingoSetResponse,
  BingoSetSummary,
} from "../../../src/modules/bingo/contracts/schemas";

const now = "2026-11-17T10:00:00.000Z";

const board = (): BingoBoardState => ({
  card: {
    title: "Stream-Abend",
    size: 3,
    cells: Array.from({ length: 9 }, (_, index) => ({ id: `cell-${String(index)}`, text: `Ereignis ${String(index)}` })),
  },
  marks: [],
  cardRevision: 7,
  markRevision: 4,
  generation: 2,
  settingsRevision: 3,
  settings: {
    backgroundOpacity: 100,
    textScale: 1,
    fontFamily: "theme",
    textEmphasis: "auto",
    ceremonyMode: "on",
    soundOnLine: false,
    soundOnFullCard: false,
    showTitle: true,
    showBingo: true,
  },
  style: "marker",
  placement: { x: 12, y: 8, scale: 1 },
});

const mutationResponse = (): BingoMutationResponse => ({
  board: board(),
  update: null,
  ceremony: null,
  auditEntry: null,
  undoTargets: [],
  serverTime: now,
});

const summary = (): BingoSetSummary => ({
  id: "set-one",
  type: "user",
  name: "Stream-Abend",
  sortOrder: 0,
  createdAt: now,
  updatedAt: now,
});

const savedSet = (): BingoSetResponse => ({
  summary: summary(),
  card: board().card,
});

const readRequest = async (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index: number) => {
  const call = fetcher.mock.calls[index];
  if (call === undefined) throw new Error(`Request ${String(index)} fehlt.`);
  const [input, init] = call;
  const request = new Request(typeof input === "string" ? new URL(input, "https://example.test") : input, init);
  return {
    url: request.url.replace("https://example.test", ""),
    method: request.method,
    body: request.body === null ? null : await request.json(),
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("BrowserAdminApi Bingo-Verträge", () => {
  it("sendet Kartenänderungen mit den passenden Konfliktrevisionen", async () => {
    const response = mutationResponse();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(board()))
      .mockResolvedValueOnce(Response.json(response))
      .mockResolvedValueOnce(Response.json(response))
      .mockResolvedValueOnce(Response.json(response))
      .mockResolvedValueOnce(Response.json(response))
      .mockResolvedValueOnce(Response.json(response));
    vi.stubGlobal("fetch", fetcher);
    const api = new BrowserAdminApi();
    const card = {
      ...board().card,
      placement: board().placement,
      expectedCardRevision: 7,
    };
    const settings = {
      baseSettingsRevision: 3,
      settings: { ...board().settings, ceremonyMode: "subtle" as const },
    };

    await expect(api.getBingoBoard()).resolves.toEqual(board());
    await expect(api.markBingoCell({ cellId: "cell-0", marked: true, expectedMarkRevision: 4 })).resolves.toEqual(response);
    await expect(api.resetBingoMarks(5)).resolves.toEqual(response);
    await expect(api.saveBingoCard(card)).resolves.toEqual(response);
    await expect(api.setBingoStyle("broadcast", 8)).resolves.toEqual(response);
    await expect(api.saveBingoSettings(settings)).resolves.toEqual(response);

    await expect(Promise.all(Array.from({ length: 6 }, (_, index) => readRequest(fetcher, index)))).resolves.toEqual([
      { url: "/api/bingo", method: "GET", body: null },
      { url: "/api/bingo/mark", method: "POST", body: { cellId: "cell-0", marked: true, expectedMarkRevision: 4 } },
      { url: "/api/bingo/reset", method: "POST", body: { expectedMarkRevision: 5 } },
      { url: "/api/bingo/board", method: "PUT", body: card },
      { url: "/api/bingo/style", method: "PUT", body: { style: "broadcast", expectedCardRevision: 8 } },
      { url: "/api/bingo/settings", method: "PUT", body: settings },
    ]);
  });

  it("verwaltet gespeicherte Sets mit normalisierten Namen und unverfälschten Exportdaten", async () => {
    const response = mutationResponse();
    const set = savedSet();
    const exported = JSON.stringify({ format: "questframe-bingo", version: 1, card: set.card });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sets: [set.summary] }))
      .mockResolvedValueOnce(Response.json(set))
      .mockResolvedValueOnce(Response.json(set))
      .mockResolvedValueOnce(Response.json(set))
      .mockResolvedValueOnce(Response.json({ ...set, summary: { ...set.summary, name: "Umbenannt" } }))
      .mockResolvedValueOnce(Response.json({ id: "set/one", deleted: true }))
      .mockResolvedValueOnce(Response.json(response))
      .mockResolvedValueOnce(Response.json(response))
      .mockResolvedValueOnce(new Response(exported));
    vi.stubGlobal("fetch", fetcher);
    const api = new BrowserAdminApi();

    await expect(api.listBingoSets()).resolves.toEqual({ sets: [set.summary] });
    await expect(api.getBingoSet("set/one")).resolves.toEqual(set);
    await expect(api.saveBingoSet("  Stream-Abend  ")).resolves.toEqual(set);
    await expect(api.saveBingoSet("Stream-Abend", "set-one")).resolves.toEqual(set);
    await expect(api.renameBingoSet("set/one", " Umbenannt ")).resolves.toEqual({
      ...set,
      summary: { ...set.summary, name: "Umbenannt" },
    });
    await expect(api.deleteBingoSet("set/one")).resolves.toBe("set/one");
    await expect(api.loadBingoSet("set/one", 7)).resolves.toEqual(response);
    await expect(api.importBingoCard(exported, 7)).resolves.toEqual(response);
    await expect(api.exportBingoCard()).resolves.toBe(exported);

    await expect(Promise.all(Array.from({ length: 9 }, (_, index) => readRequest(fetcher, index)))).resolves.toEqual([
      { url: "/api/bingo/sets", method: "GET", body: null },
      { url: "/api/bingo/sets/set%2Fone", method: "GET", body: null },
      { url: "/api/bingo/sets", method: "POST", body: { name: "Stream-Abend" } },
      { url: "/api/bingo/sets", method: "POST", body: { name: "Stream-Abend", overwriteSetId: "set-one" } },
      { url: "/api/bingo/sets/set%2Fone", method: "PATCH", body: { name: "Umbenannt" } },
      { url: "/api/bingo/sets/set%2Fone", method: "DELETE", body: null },
      { url: "/api/bingo/sets/set%2Fone/load", method: "POST", body: { expectedCardRevision: 7 } },
      { url: "/api/bingo/import", method: "POST", body: { file: exported, expectedCardRevision: 7 } },
      { url: "/api/bingo/export", method: "GET", body: null },
    ]);
  });
});
