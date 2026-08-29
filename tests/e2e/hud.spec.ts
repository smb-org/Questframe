import { expect, test, type Page } from "@playwright/test";

const loginAsLocalEditor = async (page: Page) => {
  await page.goto("/auth/dev");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Live-Steuerung" })).toBeVisible();
};

test("a draft reaches a connected OBS overlay only after Save", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop publication flow");
  await loginAsLocalEditor(page);

  await page.getByText("OBS-Link", { exact: true }).click();
  const tokenButton = page.getByRole("button", { name: /OBS-Link erzeugen|Neuen Token erzeugen/ });
  if (await tokenButton.getAttribute("class").then((value) => value?.includes("text-button") ?? false)) {
    page.once("dialog", (dialog) => dialog.accept());
  }
  await tokenButton.click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("irl-stream-hud-obs-url"))).not.toBeNull();
  const overlayUrl = await page.evaluate(() => sessionStorage.getItem("irl-stream-hud-obs-url"));
  expect(overlayUrl).not.toBeNull();

  const overlay = await context.newPage();
  await overlay.goto(overlayUrl ?? "about:blank");
  const overlayHealth = overlay.getByRole("meter", { name: /Gesundheit \d+ Prozent/ }).first();
  await expect(overlayHealth).toBeVisible();
  const current = Number(await page.getByRole("slider", { name: "Gesundheit" }).inputValue());
  const next = current === 37 ? 63 : 37;

  await page.getByRole("slider", { name: "Gesundheit" }).fill(String(next));
  await expect(overlayHealth).toHaveAttribute("aria-valuenow", String(current));
  await expect(page.getByText("Noch nicht an OBS gesendet")).toBeVisible();

  await page.getByRole("button", { name: "Änderungen speichern" }).click();
  await expect(page.getByText(/Revision \d+ ist jetzt in OBS/)).toBeVisible();
  await expect(overlayHealth).toHaveAttribute("aria-valuenow", String(next));
});

test("an unauthorized overlay stays completely transparent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop transparency gate");
  await page.goto(`/overlay?token=${"A".repeat(43)}`);

  await expect(page.locator(".hud-stage")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
});

test("mobile keeps emergency controls and removes setup surfaces", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-mobile", "Mobile emergency shell");
  await loginAsLocalEditor(page);

  await expect(page.getByRole("switch", { name: "Overlay aktiv" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Gesundheit" })).toBeVisible();
  await expect(page.getByText("Einrichten", { exact: true })).toBeHidden();
  await expect(page.getByText("OBS-Link", { exact: true })).toBeHidden();
  const controls = page.locator(".editor-rail");
  await expect(controls.getByText("Pet", { exact: true })).toBeHidden();
  await expect(controls.getByText("Gruppe", { exact: true })).toBeHidden();
});
