import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/channel/migrations";
import {
  createSqlStorageBingoRepository,
  type SqlStorageBingoRepository,
} from "../../src/modules/bingo/repository/bingo-repository";
import {
  applyBingoUndo,
  createBingoService,
} from "../../src/modules/bingo/service/commands";
import type { BingoCard } from "../../src/modules/bingo/contracts/schemas";

const actor = { twitchUserId: "123456", displayName: "Test-Mod" };
const now = "2026-11-12T12:00:00.000Z";
const migrationStub = env.CHANNEL.get(env.CHANNEL.idFromName(`bingo-migration-${crypto.randomUUID()}`));
const serviceStub = env.CHANNEL.get(env.CHANNEL.idFromName(`bingo-service-${crypto.randomUUID()}`));

const inRepository = <T>(callback: (repository: SqlStorageBingoRepository, sql: SqlStorage) => T): Promise<T> =>
  runInDurableObject(serviceStub, (_instance, state) =>
    callback(
      createSqlStorageBingoRepository({
        sql: state.storage.sql,
        transactionSync: state.storage.transactionSync.bind(state.storage),
      }),
      state.storage.sql,
    ),
  );

const serviceFor = (repository: SqlStorageBingoRepository) =>
  createBingoService({ repository, actor, clock: () => now });

const cardWith = (base: BingoCard, cells: BingoCard["cells"], size = base.size) => ({
  title: "Neue Karte",
  size,
  cells,
  placement: { x: 300, y: 8, scale: 1 },
});

const readCounts = (sql: SqlStorage): { history: number; audit: number } => ({
  history: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM state_history WHERE module_id = 'bingo'").toArray()[0]?.count ?? 0,
  audit: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM audit_log").toArray()[0]?.count ?? 0,
});

beforeEach(async () => {
  await runInDurableObject(serviceStub, (_instance, state) => {
    const sql = state.storage.sql;
    runMigrations(sql, "bingo-worker-test");
    sql.exec("DELETE FROM state_history WHERE module_id = 'bingo'");
    sql.exec("DELETE FROM audit_log");
    sql.exec("DELETE FROM bg_sets WHERE type = 'user'");
    const initialSet = sql.exec<{ payload: string }>(
      "SELECT payload FROM bg_sets WHERE type = 'template' ORDER BY sort_order LIMIT 1",
    ).toArray()[0];
    if (initialSet === undefined) throw new Error("Bingo-Vorlage fehlt.");
    const initialCard = JSON.parse(initialSet.payload) as BingoCard;
    sql.exec(`UPDATE bg_board SET
      title = ?, size = ?, cells_json = ?, marks_json = '[]',
      card_revision = 0, mark_revision = 0, generation = 0,
      placement_x = 300, placement_y = 8, placement_scale = 1, style = 'marker'
      WHERE singleton = 1`, initialCard.title, initialCard.size, JSON.stringify(initialCard.cells));
  });
});

describe("Bingo migration", () => {
  it("seeds four templates once and preserves marks and deleted sets on repeated runs", async () => {
    const result = await runInDurableObject(migrationStub, (_instance, state) => {
      const sql = state.storage.sql;
      runMigrations(sql, "bingo-first-run");
      sql.exec("UPDATE bg_board SET marks_json = ? WHERE singleton = 1", '["g01"]');
      const firstSets = sql.exec<{ id: string; name: string; payload: string }>(
        "SELECT id, name, payload FROM bg_sets ORDER BY sort_order",
      ).toArray();
      const firstBoard = sql.exec<{ title: string; marks_json: string; card_revision: number; mark_revision: number; generation: number; placement_x: number; placement_y: number }>(
        "SELECT title, marks_json, card_revision, mark_revision, generation, placement_x, placement_y FROM bg_board WHERE singleton = 1",
      ).toArray()[0];

      runMigrations(sql, "bingo-second-run");
      const secondSets = sql.exec<{ id: string; name: string; payload: string }>(
        "SELECT id, name, payload FROM bg_sets ORDER BY sort_order",
      ).toArray();
      const secondCount = sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM bg_sets").toArray()[0]?.count;
      const secondBoard = sql.exec<{ title: string; marks_json: string; card_revision: number; mark_revision: number; generation: number; placement_x: number; placement_y: number }>(
        "SELECT title, marks_json, card_revision, mark_revision, generation, placement_x, placement_y FROM bg_board WHERE singleton = 1",
      ).toArray()[0];
      sql.exec("DELETE FROM bg_sets WHERE id = ?", firstSets[0]?.id ?? "");
      runMigrations(sql, "bingo-after-delete");

      return {
        firstSets,
        secondSets,
        firstBoard,
        secondBoard,
        secondCount,
        afterDeleteCount: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM bg_sets").toArray()[0]?.count,
        remainingIds: sql.exec<{ id: string }>("SELECT id FROM bg_sets ORDER BY sort_order").toArray().map(({ id }) => id),
        versions: sql.exec<{ version: number }>("SELECT version FROM _sql_schema_migrations WHERE namespace = 'bingo'").toArray(),
      };
    });

    expect(result.firstSets).toHaveLength(4);
    expect(result.firstSets.map(({ name }) => name)).toEqual([
      "Sterben und Spielen",
      "Brudi-Sprüche",
      "Chat und Stream",
      "IRL",
    ]);
    const templatePayloadsValid = result.firstSets.every(({ payload }) => {
      const parsed: unknown = JSON.parse(payload);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        && "cells" in parsed && Array.isArray(parsed.cells) && parsed.cells.length === 16;
    });
    expect(templatePayloadsValid).toBe(true);
    expect(result.firstBoard).toMatchObject({ title: "Sterben und Spielen", marks_json: '["g01"]', card_revision: 0, mark_revision: 0, generation: 0, placement_x: 8, placement_y: 80 });
    expect(result.secondCount).toBe(4);
    expect(result.secondSets).toStrictEqual(result.firstSets);
    expect(result.secondBoard).toStrictEqual(result.firstBoard);
    expect(result.afterDeleteCount).toBe(3);
    expect(result.remainingIds).not.toContain(result.firstSets[0]?.id);
    expect(result.versions).toEqual([{ version: 1 }]);
  });
});

describe("Bingo repository and service", () => {
  it("marks cells and returns the completed diagonal as ceremony information", async () => {
    await inRepository((repository) => {
      const service = serviceFor(repository);
      let board = service.readBoard();
      let result = service.markCell("g01", true, board.markRevision);
      expect(result.ceremony).toBeNull();
      expect(result.update?.ceremony).toBeUndefined();
      board = result.board;
      result = service.markCell("g06", true, board.markRevision);
      board = result.board;
      result = service.markCell("g11", true, board.markRevision);
      board = result.board;
      result = service.markCell("g16", true, board.markRevision);

      expect(result.board.marks).toEqual(["g01", "g06", "g11", "g16"]);
      expect(result.board.markRevision).toBe(4);
      expect(result.update?.ceremony).toEqual({ lines: [{ kind: "diag", index: 0 }], fullCard: false });
    });
  });

  it("treats a repeated mark as a no-op without revision, history, audit, or update", async () => {
    await inRepository((repository, sql) => {
      const service = serviceFor(repository);
      const first = service.markCell("g01", true, 0);
      const countsBeforeRetry = readCounts(sql);
      const retry = service.markCell("g01", true, first.board.markRevision);

      expect(retry.board.markRevision).toBe(first.board.markRevision);
      expect(retry.update).toBeNull();
      expect(readCounts(sql)).toStrictEqual(countsBeforeRetry);
    });
  });

  it("rejects stale revisions and unknown cell IDs", async () => {
    await inRepository((repository) => {
      const service = serviceFor(repository);
      service.markCell("g01", true, 0);
      expect(() => service.markCell("g02", true, 0)).toThrow(expect.objectContaining({ code: "revision_conflict" }));
      expect(() => service.markCell("missing", true, 1)).toThrow(expect.objectContaining({ code: "not_found" }));
    });
  });

  it("restores reset marks through history, advances markRevision, and rejects a late retry after undo", async () => {
    await inRepository((repository, sql) => {
      const service = serviceFor(repository);
      const marked = service.markCell("g01", true, 0);
      const reset = service.resetMarks(marked.board.markRevision);
      const target = sql.exec<{ snapshot_json: string }>(
        "SELECT snapshot_json FROM state_history WHERE module_id = 'bingo' ORDER BY channel_seq DESC LIMIT 1 OFFSET 0",
      ).toArray()[0];
      if (target === undefined) throw new Error("Reset-Historie fehlt.");
      const undone = applyBingoUndo({ repository, actor, clock: () => now }, target.snapshot_json);

      expect(reset.board.marks).toEqual([]);
      expect(undone.board.marks).toEqual(["g01"]);
      expect(undone.board.markRevision).toBe(reset.board.markRevision + 1);
      expect(undone.update?.ceremony).toBeUndefined();
    });
  });

  it("rejects a late retry of a mark that was undone", async () => {
    await inRepository((repository, sql) => {
      const service = serviceFor(repository);
      service.markCell("g01", true, 0);
      const target = sql.exec<{ snapshot_json: string }>(
        "SELECT snapshot_json FROM state_history WHERE module_id = 'bingo' ORDER BY channel_seq DESC LIMIT 1",
      ).toArray()[0];
      if (target === undefined) throw new Error("Markier-Historie fehlt.");
      const undone = applyBingoUndo({ repository, actor, clock: () => now }, target.snapshot_json);

      expect(undone.board.marks).toEqual([]);
      expect(() => service.markCell("g01", true, 0)).toThrow(expect.objectContaining({ code: "revision_conflict" }));
      expect(service.readBoard().marks).toEqual([]);
    });
  });

  it("treats a concurrent duplicate mark with a stale revision as a no-op", async () => {
    await inRepository((repository, sql) => {
      const service = serviceFor(repository);
      const first = service.markCell("g01", true, 0);
      const countsBefore = readCounts(sql);
      const second = service.markCell("g01", true, 0);

      expect(second.update).toBeNull();
      expect(second.board.markRevision).toBe(first.board.markRevision);
      expect(readCounts(sql)).toStrictEqual(countsBefore);
    });
  });

  it("preserves marks by cell ID, drops removed cells, and clears marks on size changes", async () => {
    await inRepository((repository) => {
      const service = serviceFor(repository);
      let board = service.readBoard();
      board = service.markCell("g01", true, board.markRevision).board;
      const changedCells = board.card.cells.map((cell, index) => index === 1 ? { id: "new-cell", text: "Neues Feld" } : cell);
      const saved = service.saveCard({ ...cardWith(board.card, changedCells), expectedCardRevision: board.cardRevision });
      expect(saved.board.marks).toEqual(["g01"]);

      const fewerCells = saved.board.card.cells.map((cell, index) => index === 0 ? { id: "new-first", text: "Erstes Feld" } : cell);
      const removed = service.saveCard({ ...cardWith(saved.board.card, fewerCells), expectedCardRevision: saved.board.cardRevision });
      expect(removed.board.marks).toEqual([]);

      const smallerCells = removed.board.card.cells.slice(0, 9).map((cell, index) => ({ ...cell, id: `small-${String(index)}` }));
      const sizeChanged = service.saveCard({
        ...cardWith(removed.board.card, smallerCells, 3),
        expectedCardRevision: removed.board.cardRevision,
      });
      expect(sizeChanged.board.generation).toBe(1);
      expect(sizeChanged.board.marks).toEqual([]);
    });
  });

  it("persists placement-only card saves without clearing marks or changing generation", async () => {
    await inRepository((repository) => {
      const service = serviceFor(repository);
      const initial = service.readBoard();
      const firstCell = initial.card.cells[0];
      if (firstCell === undefined) throw new Error("Die Standardkarte enthält kein erstes Feld.");
      const marked = service.markCell(firstCell.id, true, initial.markRevision).board;
      const placement = { x: 84, y: 64, scale: 1.25 };

      const saved = service.saveCard({
        ...marked.card,
        placement,
        expectedCardRevision: marked.cardRevision,
      });

      expect(saved.board.placement).toEqual(placement);
      expect(saved.board.marks).toEqual(marked.marks);
      expect(saved.board.generation).toBe(marked.generation);
    });
  });

  it("advances the card revision when Undo restores placement without changing generation", async () => {
    await inRepository((repository, sql) => {
      const service = serviceFor(repository);
      const initial = service.readBoard();
      const firstPlacement = { x: 32, y: 24, scale: 1 };
      const firstSave = service.saveCard({
        ...initial.card,
        placement: firstPlacement,
        expectedCardRevision: initial.cardRevision,
      });
      const secondPlacement = { x: 96, y: 72, scale: 1.25 };
      const secondSave = service.saveCard({
        ...firstSave.board.card,
        placement: secondPlacement,
        expectedCardRevision: firstSave.board.cardRevision,
      });
      const target = sql.exec<{ snapshot_json: string }>(
        "SELECT snapshot_json FROM state_history WHERE module_id = 'bingo' ORDER BY channel_seq DESC LIMIT 1",
      ).toArray()[0];
      if (target === undefined) throw new Error("Platzierungs-Historie fehlt.");

      const undone = applyBingoUndo({ repository, actor, clock: () => now }, target.snapshot_json);

      expect(undone.board.placement).toEqual(firstPlacement);
      expect(undone.board.cardRevision).toBe(secondSave.board.cardRevision + 1);
      expect(undone.board.generation).toBe(secondSave.board.generation);
      expect(() => service.saveCard({
        ...secondSave.board.card,
        placement: secondPlacement,
        expectedCardRevision: secondSave.board.cardRevision,
      })).toThrow(expect.objectContaining({ code: "revision_conflict" }));
    });
  });

  it("rejects an old card draft after a newer save", async () => {
    await inRepository((repository) => {
      const service = serviceFor(repository);
      const board = service.readBoard();
      service.saveCard({ ...board.card, placement: board.placement, title: "Neu", expectedCardRevision: board.cardRevision });
      expect(() => service.saveCard({ ...board.card, placement: board.placement, title: "Alter Entwurf", expectedCardRevision: board.cardRevision })).toThrow(
        expect.objectContaining({ code: "revision_conflict" }),
      );
    });
  });

  it("loads a saved set with cleared marks and no ceremony", async () => {
    await inRepository((repository) => {
      const service = serviceFor(repository);
      const initial = service.readBoard();
      const savedSet = service.saveSet("Meine Karte");
      const marked = service.markCell("g01", true, initial.markRevision);
      const changed = service.saveCard({
        ...marked.board.card,
        placement: marked.board.placement,
        title: "Andere Karte",
        expectedCardRevision: marked.board.cardRevision,
      });
      const loaded = service.loadSet(savedSet.summary.id, changed.board.cardRevision);

      expect(loaded.board.card.title).toBe(initial.card.title);
      expect(loaded.board.marks).toEqual([]);
      expect(loaded.board.generation).toBe(changed.board.generation + 1);
      expect(loaded.update?.ceremony).toBeUndefined();
    });
  });

  it("imports a portable card as a replacement with cleared marks and a new generation", async () => {
    await inRepository((repository) => {
      const service = serviceFor(repository);
      const before = service.readBoard();
      const marked = service.markCell("g01", true, before.markRevision);
      const card = {
        title: "Importiert",
        size: 3 as const,
        cells: Array.from({ length: 9 }, (_, index) => ({ id: `import-${String(index)}`, text: `Feld ${String(index)}` })),
      };
      const imported = service.importCard(card, marked.board.cardRevision);

      expect(imported.board.card).toEqual(card);
      expect(imported.board.marks).toEqual([]);
      expect(imported.board.generation).toBe(marked.board.generation + 1);
      expect(imported.board.cardRevision).toBe(marked.board.cardRevision + 1);
      expect(imported.board.markRevision).toBe(marked.board.markRevision + 1);
      expect(imported.ceremony).toBeNull();
      expect(imported.update?.ceremony).toBeUndefined();
    });
  });

  it("supports creating, reading, listing, and deleting saved sets", async () => {
    await inRepository((repository) => {
      const service = serviceFor(repository);
      const saved = service.saveSet("Eigene Karte");
      expect(repository.getSet(saved.summary.id)).toEqual(saved);
      expect(service.listSets().some(({ id }) => id === saved.summary.id)).toBe(true);
      service.deleteSet(saved.summary.id);
      expect(repository.getSet(saved.summary.id)).toBeNull();
    });
  });

  // Ergänzt von Codex.
  // Value: protects=Set-Namen sind getrimmt eindeutig und höchstens 20 eigene Sets erlaubt; fails_when=Duplikat- oder Mengenprüfung fehlt; why_new=Bingo-Repo-Tests decken beide DB-Invarianten noch nicht ab; seam=none; no_claim=SQLite-Durable-Object im Worker-Test
  it("normalisiert Set-Namen und begrenzt eigene Sets auf zwanzig", async () => {
    await inRepository((repository) => {
      const service = serviceFor(repository);
      const first = service.saveSet("  Lieblingskarte  ");

      expect(first.summary.name).toBe("Lieblingskarte");
      expect(() => service.saveSet("Lieblingskarte")).toThrow(expect.objectContaining({ code: "validation_failed" }));
      for (let index = 1; index < 20; index += 1) service.saveSet(`Set ${String(index)}`);

      expect(service.listSets().filter(({ type }) => type === "user")).toHaveLength(20);
      expect(() => service.saveSet("Noch ein Set")).toThrow(expect.objectContaining({ code: "validation_failed" }));
    });
  });

  // Ergänzt von Codex.
  // Value: protects=gleicher Stil erzeugt trotz passender Revision keine Historie oder Nachricht; fails_when=der No-op Revision oder Seiteneffekte schreibt; why_new=Stiltests decken nur Änderung und Konflikt ab; seam=none; no_claim=SQLite-Durable-Object im Worker-Test
  it("behandelt denselben Stil als No-op, prüft aber zuerst die Kartenrevision", async () => {
    await inRepository((repository, sql) => {
      const service = serviceFor(repository);
      const before = service.readBoard();
      const countsBefore = readCounts(sql);

      expect(() => service.setStyle(before.style, before.cardRevision + 1)).toThrow(
        expect.objectContaining({ code: "revision_conflict" }),
      );
      const unchanged = service.setStyle(before.style, before.cardRevision);

      expect(unchanged.board).toEqual(before);
      expect(unchanged.update).toBeNull();
      expect(unchanged.ceremony).toBeNull();
      expect(unchanged.auditEntry).toBeNull();
      expect(readCounts(sql)).toStrictEqual(countsBefore);
    });
  });

  it("does not include ceremony when a history snapshot is undone", async () => {
    await inRepository((repository, sql) => {
      const service = serviceFor(repository);
      let board = service.readBoard();
      for (const cellId of ["g01", "g06", "g11", "g16"]) {
        board = service.markCell(cellId, true, board.markRevision).board;
      }
      const target = sql.exec<{ snapshot_json: string }>(
        "SELECT snapshot_json FROM state_history WHERE module_id = 'bingo' ORDER BY channel_seq ASC LIMIT 1",
      ).toArray()[0];
      if (target === undefined) throw new Error("Bingo-Historie fehlt.");
      const undone = applyBingoUndo({ repository, actor, clock: () => now }, target.snapshot_json);
      expect(undone.board.marks).toEqual([]);
      expect(undone.update?.ceremony).toBeUndefined();
    });
  });

  it("changes style without clearing marks or returning a ceremony", async () => {
    await inRepository((repository) => {
      const service = serviceFor(repository);
      const marked = service.markCell("g01", true, 0);
      const styled = service.setStyle("broadcast", marked.board.cardRevision);
      expect(styled.board.style).toBe("broadcast");
      expect(styled.board.marks).toEqual(marked.board.marks);
      expect(styled.board.cardRevision).toBe(marked.board.cardRevision + 1);
      expect(styled.update?.ceremony).toBeUndefined();
      expect(() => service.setStyle("marker", marked.board.cardRevision)).toThrow("Die Bingo-Karte wurde inzwischen geändert.");
    });
  });
});
