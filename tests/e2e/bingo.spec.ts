import { expect, test, type BrowserContext, type Page } from "@playwright/test";

type EditorBootstrap = {
  capsule: { overlayToken: { token: string | null } };
};

const loginAsLocalEditor = async (page: Page): Promise<void> => {
  await page.goto("/auth/dev", { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/admin$/);
};

const readEditorBootstrap = async (page: Page): Promise<EditorBootstrap> =>
  page.evaluate(async () => {
    const tabId = sessionStorage.getItem("irl-stream-hud-editor-tab") ?? "";
    const response = await fetch("/api/editor/bootstrap", { headers: { "x-editor-tab": tabId } });
    if (!response.ok) throw new Error(`Bootstrap fehlgeschlagen: ${String(response.status)}`);
    return response.json<EditorBootstrap>();
  });

const ensureOverlayToken = async (page: Page): Promise<string> => {
  const existing = (await readEditorBootstrap(page)).capsule.overlayToken.token;
  if (existing !== null) return existing;

  await page.getByRole("button", { name: "OBS-Einrichtung öffnen" }).click();
  const source = page.locator(".challenge-setup__source--hud");
  await expect(source).toBeVisible();
  await source.getByRole("button", { name: /OBS-Link erzeugen|Token ersetzen/ }).click();
  await expect.poll(async () => (await readEditorBootstrap(page)).capsule.overlayToken.token).not.toBeNull();
  const token = (await readEditorBootstrap(page)).capsule.overlayToken.token;
  if (token === null) throw new Error("Overlay-Token fehlt trotz erfolgreicher Erzeugung.");
  await page.keyboard.press("Escape");
  await expect(source).toBeHidden();
  return token;
};

const disposePage = async (page: Page): Promise<void> => {
  if (page.isClosed()) return;
  await page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 }).catch(() => undefined);
  if (!page.isClosed()) await page.close().catch(() => undefined);
};

const disposeContextPages = async (context: BrowserContext): Promise<void> => {
  await Promise.all(context.pages().map(disposePage));
};

test.afterEach(async ({ context }) => {
  await disposeContextPages(context);
  await context.close();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
});

test("eine Bingo-Diagonale bleibt nach dem Reload sichtbar, ohne eine Zeremonie zu erfinden", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-Bingo-Quelle");
  await loginAsLocalEditor(page);
  await page.goto("/admin/bingo");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Karte bearbeiten" })).toBeVisible();
  await expect(page.getByRole("gridcell").first()).toBeVisible();

  const token = await ensureOverlayToken(page);
  await page.getByRole("textbox", { name: "Kartentitel" }).fill("E2E Diagonale");
  await page.getByRole("combobox", { name: "Kartengröße" }).selectOption("3");
  for (let index = 0; index < 9; index += 1) {
    await page.getByRole("textbox", { name: `Feld ${String(index + 1)}` }).fill(`E2E Feld ${String(index + 1)}`);
  }
  await page.getByRole("button", { name: "Karte speichern" }).click();
  await expect(page.getByText(/Karte gespeichert · Revision \d+\./)).toBeVisible();
  // Kreuze aus früheren Läufen gegen denselben lokalen Kanal entfernen, sonst hebt ein Klick ein altes Kreuz auf.
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Kreuze zurücksetzen" }).click();
  await expect(page.locator('[role="gridcell"][data-marked="true"]')).toHaveCount(0);

  const source = await context.newPage();
  await source.goto(`/overlay/bingo#token=${token}`);
  await expect(source.getByRole("grid", { name: "E2E Diagonale" })).toBeVisible();
  for (const fieldNumber of [1, 5, 9]) {
    await page.getByRole("gridcell", { name: `E2E Feld ${String(fieldNumber)}` }).click();
  }

  await expect(source.locator('.bingo-source__cell[data-line-complete="true"]')).toHaveCount(3);
  await expect(source.locator(".bingo-source-ceremony")).toHaveAttribute("data-ceremony-type", "line");
  await source.reload();
  await expect(source.getByRole("grid", { name: "E2E Diagonale" })).toBeVisible();
  await expect(source.locator('.bingo-source__cell[data-marked="true"]')).toHaveCount(3);
  await expect(source.locator('.bingo-source__cell[data-line-complete="true"]')).toHaveCount(3);
  await expect.poll(() => source.locator(".bingo-source-ceremony").getAttribute("data-ceremony-type")).toBeNull();

  await disposePage(source);
  await disposePage(page);
});
