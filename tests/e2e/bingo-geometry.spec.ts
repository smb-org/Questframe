import { expect, test, type Page } from "@playwright/test";

type BingoStyle = "marker" | "broadcast";
type BingoBoard = {
  cardRevision: number;
  markRevision: number;
  settingsRevision: number;
  style: BingoStyle;
  settings: {
    backgroundOpacity: 0 | 25 | 50 | 75 | 100;
    textScale: number;
    fontFamily: "theme" | "atkinson" | "serif" | "sans" | "mono";
    textEmphasis: "auto" | "strong" | "plain";
    ceremonyMode: "on" | "subtle" | "off";
    soundOnLine: boolean;
    soundOnFullCard: boolean;
    showTitle: boolean;
    showBingo: boolean;
  };
  card: { title: string; size: number; cells: { id: string; text: string }[] };
};
type BingoMutation = {
  board: BingoBoard;
  update?: { ceremony?: { lines: unknown[]; fullCard: boolean } | null } | null;
};
type EditorBootstrap = {
  capsule: { overlayToken: { token: string | null } };
  csrfToken: string;
  state: {
    schemaVersion: 1;
    revision: number;
    themeId: string;
    placement: { x: number; y: number; scale: number };
    player: unknown;
    pet: unknown;
    petVisible: boolean;
    compositeHudVisible: boolean;
    group: unknown[];
    groupVisible: boolean;
    compositeChallengesVisible: boolean;
    compositeBingoVisible: boolean;
    effects: unknown[];
    featuredEffectId: string | null;
  };
};

const STAGE = { width: 1920, height: 1080 };

const loginAsLocalEditor = async (page: Page): Promise<void> => {
  await page.goto("/auth/dev", { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/admin$/);
};

const bootstrap = async (page: Page): Promise<EditorBootstrap> => page.evaluate(async () => {
  const tabId = sessionStorage.getItem("irl-stream-hud-editor-tab") ?? "";
  const response = await fetch("/api/editor/bootstrap", { headers: { "x-editor-tab": tabId } });
  if (!response.ok) throw new Error(`Bootstrap fehlgeschlagen: ${String(response.status)}`);
  return response.json<EditorBootstrap>();
});

const apiJson = async <T>(page: Page, path: string, method: string, body?: unknown): Promise<T> => page.evaluate(async (request) => {
  const tabId = sessionStorage.getItem("irl-stream-hud-editor-tab") ?? "";
  const bootstrapResponse = await fetch("/api/editor/bootstrap", { headers: { "x-editor-tab": tabId } });
  if (!bootstrapResponse.ok) throw new Error(`Bootstrap fehlgeschlagen: ${String(bootstrapResponse.status)}`);
  const current = await bootstrapResponse.json<EditorBootstrap>();
  const response = await fetch(request.path, {
    method: request.method,
    headers: {
      "content-type": "application/json",
      "x-editor-tab": tabId,
      "x-csrf-token": current.csrfToken,
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(`API ${request.path} fehlgeschlagen: ${JSON.stringify(result)}`);
  return result as T;
}, { path, method, ...(body === undefined ? {} : { body }) });

const ensureOverlayToken = async (page: Page): Promise<string> => {
  const existing = (await bootstrap(page)).capsule.overlayToken.token;
  if (existing !== null) return existing;
  await page.getByRole("button", { name: "OBS-Einrichtung öffnen" }).click();
  const source = page.locator(".challenge-setup__source--hud");
  await expect(source).toBeVisible();
  await source.getByRole("button", { name: /OBS-Link erzeugen|Token ersetzen/ }).click();
  await expect.poll(async () => (await bootstrap(page)).capsule.overlayToken.token).not.toBeNull();
  const token = (await bootstrap(page)).capsule.overlayToken.token;
  if (token === null) throw new Error("Overlay-Token fehlt trotz erfolgreicher Erzeugung.");
  await page.keyboard.press("Escape");
  await expect(source).toBeHidden();
  return token;
};

const enableCompositeBingo = async (page: Page): Promise<void> => {
  const current = await bootstrap(page);
  const { state } = current;
  await apiJson(page, "/api/state", "PUT", {
    baseRevision: state.revision,
    state: {
      schemaVersion: state.schemaVersion,
      themeId: state.themeId,
      placement: state.placement,
      player: state.player,
      pet: state.pet,
      petVisible: state.petVisible,
      compositeHudVisible: true,
      group: state.group,
      groupVisible: state.groupVisible,
      compositeChallengesVisible: true,
      compositeBingoVisible: true,
      effects: state.effects,
      featuredEffectId: state.featuredEffectId,
    },
  });
};

const ensureCompositeChallenge = async (page: Page): Promise<void> => {
  const current = await apiJson<{ boardRevision: number; challenges: { hidden: boolean }[] }>(page, "/api/challenges", "GET");
  if (current.challenges.some(({ hidden }) => !hidden)) return;
  await apiJson(page, "/api/challenges/board", "PUT", {
    baseBoardRevision: current.boardRevision,
    challenges: [{
      clientId: "bingo-size-e2e-challenge",
      title: "Challenge Log",
      kind: "counter",
      unit: null,
      targetCount: null,
      timerTotalMs: null,
      sortOrder: 0,
      step: 1,
      hidden: false,
    }],
  });
};

const saveGeometryBoard = async (page: Page, size: number, style: BingoStyle, scale = 1, cells?: string[]): Promise<BingoBoard> => {
  const current = await apiJson<BingoBoard>(page, "/api/bingo", "GET");
  const resetSettings = await apiJson<BingoMutation>(page, "/api/bingo/settings", "PUT", {
    baseSettingsRevision: current.settingsRevision,
    settings: {
      backgroundOpacity: 100, textScale: 1, fontFamily: "theme", textEmphasis: "auto",
      ceremonyMode: "on", soundOnLine: false, soundOnFullCard: false, showTitle: true, showBingo: true,
    },
  });
  const saved = await apiJson<BingoMutation>(page, "/api/bingo/board", "PUT", {
    title: `Geometrie ${String(size)}×${String(size)}`,
    size,
    cells: Array.from({ length: size * size }, (_, index) => ({ id: `geo-${String(index)}`, text: cells?.[index] ?? `Feld ${String(index + 1)}` })),
    placement: { x: 8, y: 80, scale },
    expectedCardRevision: resetSettings.board.cardRevision,
  });
  const reset = await apiJson<BingoMutation>(page, "/api/bingo/reset", "POST", {
    expectedMarkRevision: saved.board.markRevision,
  });
  const styled = await apiJson<BingoMutation>(page, "/api/bingo/style", "PUT", {
    style,
    expectedCardRevision: reset.board.cardRevision,
  });
  return styled.board;
};

const saveLargestTextSettings = async (page: Page, board: BingoBoard): Promise<BingoBoard> => {
  const saved = await apiJson<BingoMutation>(page, "/api/bingo/settings", "PUT", {
    baseSettingsRevision: board.settingsRevision,
    settings: { ...board.settings, textScale: 2, showTitle: true },
  });
  return saved.board;
};

const completeFirstRow = async (page: Page, size: number, start: BingoBoard): Promise<BingoMutation> => {
  let board = start;
  let completed: BingoMutation | null = null;
  for (let column = 0; column < size; column += 1) {
    const result = await apiJson<BingoMutation>(page, "/api/bingo/mark", "POST", {
      cellId: `geo-${String(column)}`,
      marked: true,
      expectedMarkRevision: board.markRevision,
    });
    board = result.board;
    completed = result;
  }
  if (completed === null) throw new Error("Die Bingo-Reihe konnte nicht abgeschlossen werden.");
  return completed;
};

const intersectionArea = (left: { x: number; y: number; width: number; height: number }, right: { x: number; y: number; width: number; height: number }): number => {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
};

const unionBounds = (left: { x: number; y: number; width: number; height: number }, right: { x: number; y: number; width: number; height: number }) => {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  return {
    x,
    y,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y,
  };
};

const assertInsideStage = async (page: Page, selector: string): Promise<void> => {
  const box = await page.locator(selector).boundingBox();
  expect(box, `${selector} muss messbar sein`).not.toBeNull();
  expect(box?.x ?? -1, `${selector} links`).toBeGreaterThanOrEqual(0);
  expect(box?.y ?? -1, `${selector} oben`).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0), `${selector} rechts`).toBeLessThanOrEqual(STAGE.width);
  expect((box?.y ?? 0) + (box?.height ?? 0), `${selector} unten`).toBeLessThanOrEqual(STAGE.height);
};

test("hält Bingo-Titel, Karte und Abschlussbadge bei allen Größen und Stilen im Composite", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-Composite-Geometrie");
  await loginAsLocalEditor(page);
  await page.goto("/admin/bingo");
  await expect(page.getByRole("heading", { name: "Karte bearbeiten" })).toBeVisible();
  const token = await ensureOverlayToken(page);
  await enableCompositeBingo(page);
  await ensureCompositeChallenge(page);

  const composite = await context.newPage();
  await composite.setViewportSize(STAGE);
  await composite.emulateMedia({ reducedMotion: "reduce" });
  await composite.goto(`/overlay/all#token=${token}`);
  await expect(composite.locator(".bingo-source-ceremony")).toBeAttached();
  await expect(composite.locator(".bingo-source")).toBeVisible();

  const markerHudOverlapBySize = new Map<string, number>();
  for (const style of ["marker", "broadcast"] as const) {
    for (const size of [3, 4, 5]) {
      for (const scale of [1, 2]) {
        let board = await saveGeometryBoard(page, size, style, scale);
        if (size === 5 || scale === 2) board = await saveLargestTextSettings(page, board);
        const completed = await completeFirstRow(page, size, board);
        expect(completed.update?.ceremony?.lines.length).toBeGreaterThan(0);

        const visibleBoard = composite.locator(`.bingo-source[data-style="${style}"]`);
        await expect(visibleBoard).toBeVisible();
        await expect(visibleBoard.locator('.bingo-source__cell[data-line-complete="true"]')).toHaveCount(size);
        await expect(composite.locator(".bingo-source-ceremony")).toHaveAttribute("data-ceremony-type", "line");
        await assertInsideStage(composite, ".bingo-source");
        await assertInsideStage(composite, ".bingo-source__header");
        await assertInsideStage(composite, ".bingo-source__title");
        if (scale === 1) {
          const boardBox = await visibleBoard.boundingBox();
          expect(boardBox).not.toBeNull();
          expect(Math.abs((boardBox?.width ?? 0) - 260)).toBeLessThanOrEqual(2);
        }
        const boardBox = await visibleBoard.boundingBox();
        expect(boardBox).not.toBeNull();
        expect(Math.abs((boardBox?.width ?? 0) - 260 * scale)).toBeLessThanOrEqual(2);
        if (size === 5) {
          expect(await visibleBoard.locator(".bingo-source__text").evaluateAll((texts) => texts.every((text) => {
            const textRect = text.getBoundingClientRect();
            const cellRect = text.parentElement?.getBoundingClientRect();
            return cellRect !== undefined
              && textRect.left >= cellRect.left
              && textRect.top >= cellRect.top
              && textRect.right <= cellRect.right
              && textRect.bottom <= cellRect.bottom;
          }))).toBe(true);
          expect(await composite.locator(".bingo-source-ceremony").evaluate((stage) => getComputedStyle(stage).getPropertyValue("--bingo-scale").trim())).toBe(String(scale));
        }

        if (style === "broadcast") {
          await expect(visibleBoard.locator(".bingo-source__bingo-badge")).toBeVisible();
          await assertInsideStage(composite, ".bingo-source__bingo-badge");
        } else {
          await expect(composite.locator(".bingo-source__bingo-callout")).toBeVisible();
          await assertInsideStage(composite, ".bingo-source__bingo-callout");
        }

        const panelBox = await visibleBoard.boundingBox();
        const accentSelector = style === "marker" ? ".bingo-source__bingo-callout" : ".bingo-source__bingo-badge";
        const accentBox = await composite.locator(accentSelector).boundingBox();
        const hudBox = await composite.locator(".hud-stage").boundingBox();
        expect(panelBox).not.toBeNull();
        expect(accentBox).not.toBeNull();
        expect(hudBox).not.toBeNull();
        const visualBounds = unionBounds(
          panelBox as NonNullable<typeof panelBox>,
          accentBox as NonNullable<typeof accentBox>,
        );
        const overlap = intersectionArea(visualBounds, hudBox as NonNullable<typeof hudBox>);
        const overlapKey = `${String(size)}-${String(scale)}`;
        if (style === "marker") markerHudOverlapBySize.set(overlapKey, overlap);
        if (style === "broadcast") expect(overlap).toBeLessThanOrEqual(markerHudOverlapBySize.get(overlapKey) ?? 0);

        if (size === 5) {
          await composite.screenshot({ omitBackground: true, path: testInfo.outputPath(`bingo-${style}-${String(scale)}x-1920x1080.png`) });
        }
      }
    }
  }

  const longTextCells = Array.from({ length: 25 }, (_, index) => `Langes Bingo-Feld ${String(index + 1)} mit vielen Wörtern.`);
  for (const style of ["marker", "broadcast"] as const) {
    const board = await saveGeometryBoard(page, 5, style, 0.75, longTextCells);
    await saveLargestTextSettings(page, board);
    const visibleBoard = composite.locator(`.bingo-source[data-style="${style}"]`);
    await expect(visibleBoard).toBeVisible();
    const boardBox = await visibleBoard.boundingBox();
    expect(boardBox).not.toBeNull();
    expect(Math.abs((boardBox?.width ?? 0) - 195)).toBeLessThanOrEqual(2);
    const textLayoutErrors = await visibleBoard.locator(".bingo-source__text").evaluateAll((texts) => texts.flatMap((text, index) => {
      const textRect = text.getBoundingClientRect();
      const cellRect = text.parentElement?.getBoundingClientRect();
      const renderedFontSize = Number.parseFloat(getComputedStyle(text).fontSize) * 0.75;
      if (cellRect !== undefined
        && renderedFontSize >= 8
        && textRect.left >= cellRect.left
        && textRect.top >= cellRect.top
        && textRect.right <= cellRect.right
        && textRect.bottom <= cellRect.bottom) return [];
      return [{ index, renderedFontSize, textHeight: textRect.height, cellHeight: cellRect?.height ?? null }];
    }));
    expect(textLayoutErrors).toEqual([]);
  }

  const captureBoard = async (scale: number, path: string): Promise<void> => {
    await saveGeometryBoard(page, 4, "marker", scale);
    await expect(composite.locator('.bingo-source[data-style="marker"]')).toBeVisible();
    await expect(composite.locator(".hud-stage")).toBeVisible();
    await expect(composite.locator(".challenge-source")).toBeVisible();
    await composite.screenshot({ omitBackground: true, path: testInfo.outputPath(path) });
  };
  await captureBoard(1, "size-1.png");
  await captureBoard(0.75, "size-075.png");

  await composite.close();
  await page.close();
});
