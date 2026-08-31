import { expect, test, type Page } from "@playwright/test";

const loginAsLocalEditor = async (page: Page) => {
  await page.goto("/auth/dev");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("tab", { name: "HUD" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("slider", { name: "Gesundheit", exact: true })).toBeVisible();
};

test("a draft reaches a connected OBS overlay only after Save", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop publication flow");
  await loginAsLocalEditor(page);

  const tokenButton = page.getByRole("button", { name: /OBS-Link erzeugen|Neuen Token erzeugen/ });
  page.once("dialog", (dialog) => dialog.accept());
  await tokenButton.click();
  await expect.poll(async () => page.evaluate(async () => {
    const tabId = sessionStorage.getItem("irl-stream-hud-editor-tab") ?? "";
    const response = await fetch("/api/editor/bootstrap", { headers: { "x-editor-tab": tabId } });
    const body = await response.json<{ capsule: { overlayToken: { token: string | null } } }>();
    return body.capsule.overlayToken.token === null
      ? null
      : `${window.location.origin}/overlay#token=${body.capsule.overlayToken.token}`;
  })).not.toBeNull();
  const overlayUrl = await page.evaluate(async () => {
    const tabId = sessionStorage.getItem("irl-stream-hud-editor-tab") ?? "";
    const response = await fetch("/api/editor/bootstrap", { headers: { "x-editor-tab": tabId } });
    const body = await response.json<{ capsule: { overlayToken: { token: string | null } } }>();
    return body.capsule.overlayToken.token === null
      ? null
      : `${window.location.origin}/overlay#token=${body.capsule.overlayToken.token}`;
  });

  const overlay = await context.newPage();
  await overlay.goto(overlayUrl ?? "about:blank");
  const overlayHealth = overlay.getByRole("meter", { name: /Gesundheit \d+ Prozent/ }).first();
  await expect(overlayHealth).toBeVisible();
  const playerHealth = page.getByRole("slider", { name: "Gesundheit", exact: true });
  const current = Number(await playerHealth.inputValue());
  const next = current === 37 ? 63 : 37;

  await playerHealth.fill(String(next));
  await expect(overlayHealth).toHaveAttribute("aria-valuenow", String(current));
  await expect(page.getByText("Noch nicht an OBS gesendet")).toBeVisible();

  await page.getByRole("button", { name: "Änderungen speichern" }).click();
  await expect(page.getByText(/Revision \d+ ist jetzt in OBS/)).toBeVisible();
  await expect(overlayHealth).toHaveAttribute("aria-valuenow", String(next));
});

test("an unauthorized overlay stays completely transparent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop transparency gate");
  await page.goto(`/overlay#token=${"A".repeat(43)}`);

  await expect(page.locator(".hud-stage")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
});

test("preview zoom keeps its slider fixed through 200 percent and resets to 100", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop preview zoom");
  await page.setViewportSize({ width: 2560, height: 1440 });
  await loginAsLocalEditor(page);

  const zoom = page.getByRole("slider", { name: "Vorschau-Zoom" });
  const canvas = page.locator(".preview-canvas");
  const reset = page.getByRole("button", { name: "Vorschau-Zoom auf 100 % zurücksetzen" });
  const sliderBefore = await zoom.boundingBox();
  const canvasBefore = await canvas.boundingBox();
  expect(sliderBefore).not.toBeNull();
  expect(canvasBefore).not.toBeNull();

  await zoom.fill("200");
  await expect(zoom).toHaveValue("200");
  const sliderAfter = await zoom.boundingBox();
  const canvasAfter = await canvas.boundingBox();
  expect(sliderAfter?.x).toBeCloseTo(sliderBefore?.x ?? 0, 1);
  expect(sliderAfter?.y).toBeCloseTo(sliderBefore?.y ?? 0, 1);
  expect(sliderAfter?.width).toBeCloseTo(sliderBefore?.width ?? 0, 1);
  expect(canvasAfter?.width ?? 0).toBeGreaterThan((canvasBefore?.width ?? 0) * 1.9);

  await reset.click();
  await expect(zoom).toHaveValue("100");
  await expect(reset).toBeDisabled();
});

test("the live preview spans the panel width and stays pannable when zoomed", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop preview framing");
  await page.setViewportSize({ width: 2560, height: 1440 });
  await loginAsLocalEditor(page);

  const heading = await page.locator(".panel-heading").boundingBox();
  const viewport = await page.locator(".preview-viewport").boundingBox();
  expect(heading).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(viewport?.x ?? 0).toBeCloseTo(heading?.x ?? 0, 0);
  expect((viewport?.x ?? 0) + (viewport?.width ?? 0)).toBeCloseTo(
    (heading?.x ?? 0) + (heading?.width ?? 0),
    0,
  );

  await page.getByRole("slider", { name: "Vorschau-Zoom" }).fill("200");
  const zoomed = await page.locator(".preview-viewport").boundingBox();
  expect(zoomed?.width ?? 0).toBeCloseTo(viewport?.width ?? 0, 0);
  expect(zoomed?.height ?? 0).toBeCloseTo(viewport?.height ?? 0, 0);

  const scroll = await page.locator(".preview-viewport").evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    scrollLeft: element.scrollLeft,
    scrollTop: element.scrollTop,
  }));
  expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth * 1.9);
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight * 1.9);
  expect(scroll.scrollLeft).toBe(0);
  expect(scroll.scrollTop).toBe(0);
});

test("the header names the Twitch channel being edited", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop header identity");
  await loginAsLocalEditor(page);

  const identity = page.locator(".admin-topbar .channel-identity");
  await expect(identity).toBeVisible();
  await expect(identity.locator("strong")).not.toBeEmpty();
});

test("preview zoom controls stay inside the narrow tablet main column", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Tablet-width desktop controls");
  await page.setViewportSize({ width: 780, height: 1000 });
  await loginAsLocalEditor(page);

  const heading = await page.locator(".panel-heading").boundingBox();
  const controls = await page.locator(".preview-controls").boundingBox();
  expect(heading).not.toBeNull();
  expect(controls).not.toBeNull();
  expect(controls?.x ?? 0).toBeGreaterThanOrEqual(heading?.x ?? 0);
  expect((controls?.x ?? 0) + (controls?.width ?? 0)).toBeLessThanOrEqual(
    (heading?.x ?? 0) + (heading?.width ?? 0) + 1,
  );
});

test("mobile keeps emergency controls and removes setup surfaces", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-mobile", "Mobile emergency shell");
  await loginAsLocalEditor(page);

  await expect(page.getByRole("switch", { name: "Overlay aktiv" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Gesundheit" })).toBeVisible();
  await expect(page.getByText("Einrichten", { exact: true })).toBeHidden();
  await expect(page.locator(".obs-chip")).toBeHidden();
  const controls = page.locator(".editor-rail");
  await expect(controls.getByText("Pet", { exact: true })).toBeHidden();
  await expect(controls.getByText("Gruppe", { exact: true })).toBeHidden();
});
