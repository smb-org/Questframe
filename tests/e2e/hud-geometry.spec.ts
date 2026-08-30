import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Geometrievertrag des OBS-Overlays. Geprueft werden Bounding Boxes, nicht Pixel,
 * damit die Erwartungen plattformunabhaengig bleiben.
 */

const STAGE = { width: 630, height: 259 };
const PLAYER_HEIGHT = 175;

/**
 * Jede Variante fuellt dieselbe Breite. Die Bildvarianten strecken ihr
 * Rahmenasset dafuer ueber ein horizontales 3-Slice (--hud-chrome-slice-*).
 */
const PLAYER_WIDTH = 430;

const PARTY_WIDTH: Record<string, number> = {
  "trail-wood": 178,
  "field-journal": 148,
  "forged-compass": 166,
  "classic-simple": 190,
  "modern-compact": 190,
  "modern-minimal": 190,
};

const SHARED_BOXES = {
  ".hud-support-row": { x: 0, y: 179, height: 80 },
  ".hud-feature-slot": { x: 294, y: 179, width: 136, height: 80 },
  ".hud-party": { x: 440, y: 0, height: 259 },
} as const;

const IMAGE_VARIANTS = ["trail-wood", "field-journal", "forged-compass"] as const;
const ALL_VARIANTS = Object.keys(PARTY_WIDTH);

const APERTURE_BOXES = {
  "trail-wood": {
    playerPortrait: { x: 18, y: 19, width: 92, height: 92 },
    playerName: { x: 158, y: 29, width: 206, height: 17 },
    playerTitle: { x: 135, y: 47, width: 261 },
    playerHealth: { x: 135, y: 57, width: 261, height: 15 },
    playerResource: { x: 135, y: 86, width: 261, height: 15 },
    petPortrait: { x: 11, y: 11, width: 26, height: 26 },
    petName: { x: 46, y: 10, width: 105, height: 14 },
    petBar: { x: 45, y: 31, width: 106, height: 8 },
    partyPortrait: { x: 10, y: 14, width: 22, height: 22 },
    partyName: { x: 42, y: 13, width: 121, height: 13 },
    partyBar: { x: 41, y: 33, width: 123, height: 8 },
  },
  "field-journal": {
    playerPortrait: { x: 37, y: 31, width: 97, height: 97 },
    playerName: { x: 189, y: 38, width: 180, height: 20 },
    playerTitle: { x: 189, y: 58, width: 180 },
    playerHealth: { x: 171, y: 75, width: 225, height: 26 },
    playerResource: { x: 171, y: 103, width: 225, height: 25 },
    petPortrait: { x: 9, y: 14, width: 20, height: 20 },
    petName: { x: 39, y: 11, width: 86, height: 12 },
    petBar: { x: 39, y: 30, width: 86 },
    partyPortrait: { x: 10, y: 11, width: 24, height: 24 },
    partyName: { x: 41, y: 9, width: 98, height: 13 },
    partyBar: { x: 41, y: 30, width: 98 },
  },
  "forged-compass": {
    playerPortrait: { x: 15, y: 14, width: 116, height: 116 },
    playerName: { x: 181, y: 44, width: 186, height: 15 },
    playerTitle: { x: 152, y: 59, width: 254 },
    playerHealth: { x: 152, y: 68, width: 254, height: 27 },
    playerResource: { x: 152, y: 104, width: 254, height: 26 },
    petPortrait: { x: 8, y: 6, width: 31, height: 31 },
    petName: { x: 51, y: 8, width: 78, height: 11 },
    petBar: { x: 51, y: 33, width: 78 },
    partyPortrait: { x: 7, y: 8, width: 27, height: 27 },
    partyName: { x: 43, y: 8, width: 111, height: 12 },
    partyBar: { x: 43, y: 35, width: 111 },
  },
} as const;

const loginAsLocalEditor = async (page: Page) => {
  await page.goto("/auth/dev");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Live-Steuerung" })).toBeVisible();
};

const publishDenseState = (page: Page, themeId: string, scale = 1) =>
  page.evaluate(async ({ theme, hudScale }) => {
    const tabId = crypto.randomUUID();
    const bootstrapResponse = await fetch("/api/editor/bootstrap", {
      headers: { "x-editor-tab": tabId },
    });
    const bootstrap = await bootstrapResponse.json<{
      csrfToken: string;
      state: { revision: number };
    }>();
    const response = await fetch("/api/state", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-editor-tab": tabId,
        "x-csrf-token": bootstrap.csrfToken,
      },
      body: JSON.stringify({
        baseRevision: bootstrap.state.revision,
        state: {
          schemaVersion: 1,
          themeId: theme,
          placement: { x: 0, y: 0, scale: hudScale },
          petVisible: true,
          groupVisible: true,
          player: {
            name: "Alexandra Bergsteigerin XY",
            title: "Chefin der Hochgebirgsexpedition",
            level: 999,
            portrait: { kind: "initials", text: "AB" },
            hpPercent: 19,
            resource: { name: "Energie", color: "#C2410C", percent: 100 },
          },
          pet: {
            name: "Begleiter",
            subtitle: "Wanderhund",
            portrait: { kind: "initials", text: "BE" },
            hpPercent: 0,
          },
          group: Array.from({ length: 5 }, (_, index) => ({
            id: `guest-${String(index)}`,
            source: "manual",
            twitchUserId: null,
            name: `Gast Nummer ${String(index)}`,
            portrait: { kind: "initials", text: "GA" },
            hpPercent: 70,
          })),
          effects: Array.from({ length: 8 }, (_, index) => ({
            id: `effect-${String(index)}`,
            catalogId: "buff-gestaerkt",
            kind: index % 2 === 0 ? "buff" : "debuff",
            name: `Effekt ${String(index)}`,
            description: index === 0 ? "Bereit für das nächste Abenteuer." : null,
            iconId: "buff-gestaerkt",
            stacks: null,
            expiresAt: null,
            order: index,
          })),
          featuredEffectId: "effect-0",
        },
      }),
    });
    if (!response.ok) throw new Error(`save failed: ${String(response.status)}`);
  }, { theme: themeId, hudScale: scale });

const openOverlay = async (page: Page) => {
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /OBS-Link erzeugen|Neuen Token erzeugen/ }).click();
  await expect.poll(async () => page.evaluate(async () => {
    const tabId = sessionStorage.getItem("irl-stream-hud-editor-tab") ?? "";
    const response = await fetch("/api/editor/bootstrap", { headers: { "x-editor-tab": tabId } });
    const body = await response.json<{ capsule: { overlayToken: { token: string | null } } }>();
    return body.capsule.overlayToken.token === null
      ? null
      : `${window.location.origin}/overlay#token=${body.capsule.overlayToken.token}`;
  })).not.toBeNull();
  const url = await page.evaluate(async () => {
    const tabId = sessionStorage.getItem("irl-stream-hud-editor-tab") ?? "";
    const response = await fetch("/api/editor/bootstrap", { headers: { "x-editor-tab": tabId } });
    const body = await response.json<{ capsule: { overlayToken: { token: string | null } } }>();
    return body.capsule.overlayToken.token === null
      ? null
      : `${window.location.origin}/overlay#token=${body.capsule.overlayToken.token}`;
  });
  expect(url).not.toBeNull();
  return url ?? "about:blank";
};

const boxIn = async (page: Page, selector: string, origin: { x: number; y: number }) => {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `${selector} must be laid out`).not.toBeNull();
  return {
    x: Math.round((box?.x ?? 0) - origin.x),
    y: Math.round((box?.y ?? 0) - origin.y),
    width: Math.round(box?.width ?? 0),
    height: Math.round(box?.height ?? 0),
  };
};

test.describe.configure({ mode: "serial" });

test.describe("HUD geometry contract", () => {
  // Der OBS-Token ist kanalweit. Einmal erzeugen reicht fuer die ganze Datei.
  let overlayUrl = "";
  let overlayContext: BrowserContext | null = null;
  let overlayPage: Page | null = null;

  test.beforeAll(async ({ browser }, testInfo) => {
    if (testInfo.project.name !== "chromium-desktop") return;
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsLocalEditor(page);
    overlayUrl = await openOverlay(page);
    await context.close();
    overlayContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    overlayPage = await overlayContext.newPage();
  });

  test.afterAll(async () => {
    await overlayContext?.close();
  });

  const getOverlayPage = () => {
    if (overlayPage === null) throw new Error("Desktop overlay page was not initialized");
    return overlayPage;
  };

  const syncOverlay = async (page: Page, overlay: Page, themeId: string, scale = 1) => {
    await publishDenseState(page, themeId, scale);
    if (overlay.url() === "about:blank") await overlay.goto(overlayUrl);
    await expect(overlay.locator(`.hud-root.hud-theme--${themeId}`)).toHaveCount(1);
    await expect.poll(() => overlay.locator(".hud-root").evaluate((node) =>
      getComputedStyle(node).getPropertyValue("--hud-scale").trim(),
    )).toBe(String(scale));
  };

  test("keeps every unit frame inside the stage grid across all variants", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop geometry contract");
    await loginAsLocalEditor(page);

    const overlay = getOverlayPage();

    for (const themeId of ALL_VARIANTS) {
      await syncOverlay(page, overlay, themeId);
      const stage = overlay.locator(".hud-stage");
      await expect(stage).toHaveCount(1);
      await expect(overlay.locator(".hud-effect")).toHaveCount(8);
      await expect(overlay.locator('.hud-party [data-unit-kind="party"]')).toHaveCount(5);
      await expect(overlay.locator('.hud-pet-slot [data-unit-kind="pet"]')).toHaveCount(1);

      const stageBox = await stage.boundingBox();
      const origin = { x: stageBox?.x ?? 0, y: stageBox?.y ?? 0 };
      expect(Math.round(stageBox?.width ?? 0)).toBe(STAGE.width);
      expect(Math.round(stageBox?.height ?? 0)).toBe(STAGE.height);

      expect(await boxIn(overlay, ".hud-player", origin), `${themeId} player`).toEqual({
        x: 0,
        y: 0,
        width: PLAYER_WIDTH,
        height: PLAYER_HEIGHT,
      });

      expect((await boxIn(overlay, ".hud-party", origin)).width, `${themeId} party.width`).toBe(
        PARTY_WIDTH[themeId],
      );

      for (const [selector, expected] of Object.entries(SHARED_BOXES)) {
        const actual = await boxIn(overlay, selector, origin);
        for (const [key, value] of Object.entries(expected)) {
          expect(actual[key as keyof typeof actual], `${themeId} ${selector}.${key}`).toBe(value);
        }
      }

      // Nichts darf ueber die Stage hinausragen.
      for (const selector of [
        ".hud-player",
        ".hud-level-medallion",
        ".hud-support-row",
        ".hud-pet-slot",
        ".hud-party",
      ]) {
        const box = await boxIn(overlay, selector, origin);
        expect(box.x, `${themeId} ${selector} left`).toBeGreaterThanOrEqual(0);
        expect(box.y, `${themeId} ${selector} top`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${themeId} ${selector} right`).toBeLessThanOrEqual(STAGE.width);
        expect(box.y + box.height, `${themeId} ${selector} bottom`).toBeLessThanOrEqual(STAGE.height);
      }

      // Das Levelmedaillon liegt im Spielerframe, aber nie im geclippten Portrait.
      const medallionInsidePortrait = await overlay
        .locator(".hud-player-portrait")
        .evaluate((node) => node.querySelector(".hud-level-medallion") !== null);
      expect(medallionInsidePortrait, themeId).toBe(false);
    }
  });

  test("keeps portraits, names, and compact bars inside their theme apertures", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop aperture contract");
    await loginAsLocalEditor(page);

    const overlay = getOverlayPage();

    for (const [themeId, expected] of Object.entries(APERTURE_BOXES)) {
      await syncOverlay(page, overlay, themeId);

      const player = await overlay.locator(".hud-player").boundingBox();
      const playerOrigin = { x: player?.x ?? 0, y: player?.y ?? 0 };
      const pet = await overlay.locator(".hud-pet").boundingBox();
      const petOrigin = { x: pet?.x ?? 0, y: pet?.y ?? 0 };
      const party = await overlay.locator(".hud-party-member").first().boundingBox();
      const partyOrigin = { x: party?.x ?? 0, y: party?.y ?? 0 };

      expect(await boxIn(overlay, ".hud-player-portrait", playerOrigin), themeId).toEqual(
        expected.playerPortrait,
      );
      expect(await boxIn(overlay, ".hud-player-heading", playerOrigin), themeId).toEqual(
        expected.playerName,
      );
      expect(await boxIn(overlay, ".hud-player-title", playerOrigin), themeId).toMatchObject(
        expected.playerTitle,
      );
      expect(
        await boxIn(overlay, ".hud-player .hud-bar--health", playerOrigin),
        themeId,
      ).toEqual(expected.playerHealth);
      expect(
        await boxIn(overlay, ".hud-player .hud-bar--resource", playerOrigin),
        themeId,
      ).toEqual(expected.playerResource);
      expect(await boxIn(overlay, ".hud-pet .hud-compact-portrait", petOrigin), themeId).toEqual(
        expected.petPortrait,
      );
      expect(await boxIn(overlay, ".hud-pet .hud-compact-name-row", petOrigin), themeId).toEqual(
        expected.petName,
      );
      expect(await boxIn(overlay, ".hud-pet .hud-compact-bar", petOrigin), themeId).toMatchObject(
        expected.petBar,
      );
      expect(
        await boxIn(overlay, ".hud-party-member .hud-compact-portrait", partyOrigin),
        themeId,
      ).toEqual(expected.partyPortrait);
      expect(
        await boxIn(overlay, ".hud-party-member .hud-compact-name-row", partyOrigin),
        themeId,
      ).toEqual(expected.partyName);
      expect(
        await boxIn(overlay, ".hud-party-member .hud-compact-bar", partyOrigin),
        themeId,
      ).toMatchObject(expected.partyBar);
    }
  });

  test("keeps modern portrait imagery clear of the adjacent body surface", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop modern geometry");
    await loginAsLocalEditor(page);
    const overlay = getOverlayPage();

    for (const themeId of ["modern-compact", "modern-minimal"]) {
      await syncOverlay(page, overlay, themeId);
      const portrait = await overlay.locator(".hud-player-portrait").boundingBox();
      const body = await overlay.locator(".hud-player-body").boundingBox();
      expect(body?.x ?? 0, themeId).toBeGreaterThanOrEqual(
        (portrait?.x ?? 0) + (portrait?.width ?? 0) - 2,
      );
    }
  });

  test("keeps classic simple transparent between local name and bar surfaces", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop classic surface contract");
    await loginAsLocalEditor(page);

    const overlay = getOverlayPage();
    await syncOverlay(page, overlay, "classic-simple");

    const surfaces = await overlay.evaluate(() => {
      const styleOf = (selector: string) =>
        getComputedStyle(document.querySelector(selector) as Element);
      const playerBody = styleOf(".hud-player-body");
      const playerName = styleOf(".hud-player-heading");
      const compactBody = styleOf(".hud-pet");
      const compactName = styleOf(".hud-pet .hud-compact-name-row");
      const playerHealth = styleOf(".hud-player .hud-bar--health");
      const compactHealth = styleOf(".hud-pet .hud-bar--health");
      const rectOf = (selector: string) =>
        (document.querySelector(selector) as Element).getBoundingClientRect();
      const nameRect = rectOf(".hud-player-heading");
      const titleRect = rectOf(".hud-player-title");
      const healthRect = rectOf(".hud-player .hud-bar--health");
      const resourceRect = rectOf(".hud-player .hud-bar--resource");
      return {
        playerBodyImage: playerBody.backgroundImage,
        playerBodyBorder: playerBody.borderTopWidth,
        playerNameImage: playerName.backgroundImage,
        playerNameBorder: playerName.borderTopColor,
        playerHealthBorder: playerHealth.borderTopColor,
        nameToHealthGap: Math.round(healthRect.top - nameRect.bottom),
        healthToResourceGap: Math.round(resourceRect.top - healthRect.bottom),
        titleInsideName: titleRect.top >= nameRect.top && titleRect.bottom <= nameRect.bottom,
        compactBodyImage: compactBody.backgroundImage,
        compactBodyBorder: compactBody.borderTopWidth,
        compactNameImage: compactName.backgroundImage,
        compactNameBorder: compactName.borderTopColor,
        compactHealthBorder: compactHealth.borderTopColor,
      };
    });

    expect(surfaces.playerBodyImage).toBe("none");
    expect(surfaces.playerBodyBorder).toBe("0px");
    expect(surfaces.playerNameImage).toContain("linear-gradient");
    expect(surfaces.playerNameBorder).not.toBe("rgb(0, 0, 0)");
    expect(surfaces.playerHealthBorder).not.toBe("rgb(0, 0, 0)");
    expect(surfaces.nameToHealthGap).toBeLessThanOrEqual(6);
    expect(surfaces.healthToResourceGap).toBeLessThanOrEqual(6);
    expect(surfaces.titleInsideName).toBe(true);
    expect(surfaces.compactBodyImage).toBe("none");
    expect(surfaces.compactBodyBorder).toBe("0px");
    expect(surfaces.compactNameImage).toContain("linear-gradient");
    expect(surfaces.compactNameBorder).not.toBe("rgb(0, 0, 0)");
    expect(surfaces.compactHealthBorder).not.toBe("rgb(0, 0, 0)");
  });

  test("renders a rounded themed material on health and resource fills", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop bar material");
    await loginAsLocalEditor(page);
    const overlay = getOverlayPage();

    for (const themeId of ALL_VARIANTS) {
      await syncOverlay(page, overlay, themeId);
      const surfaces = await overlay.evaluate(() => {
        const health = getComputedStyle(document.querySelector(".hud-bar--health .hud-bar-fill") as Element);
        const resource = getComputedStyle(document.querySelector(".hud-bar--resource .hud-bar-fill") as Element);
        return {
          healthTexture: health.backgroundImage,
          healthRadius: Number.parseFloat(health.borderRadius),
          resourceTexture: resource.backgroundImage,
          resourceColor: resource.backgroundColor,
        };
      });
      expect(surfaces.healthTexture, themeId).toContain("linear-gradient");
      expect(surfaces.resourceTexture, themeId).toContain("linear-gradient");
      expect(surfaces.healthRadius, themeId).toBeGreaterThanOrEqual(2);
      expect(surfaces.resourceColor, themeId).not.toBe("rgb(194, 65, 12)");
    }
  });

  test("holds the geometry at every HUD scale", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop scale contract");
    await loginAsLocalEditor(page);
    const overlay = getOverlayPage();

    for (const scale of [0.75, 1, 1.25, 1.5, 1.75, 2]) {
      await syncOverlay(page, overlay, "trail-wood", scale);

      const stage = await overlay.locator(".hud-stage").boundingBox();
      const medallion = await overlay.locator(".hud-level-medallion").boundingBox();
      const playerPortrait = await overlay.locator(".hud-player-portrait").boundingBox();
      const pet = await overlay.locator(".hud-pet").boundingBox();
      const petPortrait = await overlay.locator(".hud-pet .hud-compact-portrait").boundingBox();
      expect(Math.round((stage?.width ?? 0) / scale)).toBe(STAGE.width);
      expect(Math.round((medallion?.width ?? 0) / scale)).toBe(38);
      expect(Math.round(((medallion?.x ?? 0) - (stage?.x ?? 0)) / scale)).toBe(18);
      expect(Math.round(((playerPortrait?.x ?? 0) - (stage?.x ?? 0)) / scale)).toBe(18);
      expect(Math.round((playerPortrait?.width ?? 0) / scale)).toBe(92);
      expect(Math.round(((petPortrait?.x ?? 0) - (pet?.x ?? 0)) / scale)).toBe(11);
      expect(Math.round(((petPortrait?.y ?? 0) - (pet?.y ?? 0)) / scale)).toBe(11);
      expect(Math.round((petPortrait?.width ?? 0) / scale)).toBe(26);
    }
  });

  test("loads frame assets for image variants and none for CSS variants", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop asset wiring");
    await loginAsLocalEditor(page);
    const overlay = getOverlayPage();

    for (const themeId of ALL_VARIANTS) {
      await syncOverlay(page, overlay, themeId);

      const layers = await overlay.evaluate(() => ({
        // Der Spieler-Chrome haengt als border-image am Element, nicht als Hintergrund.
        player: getComputedStyle(document.querySelector(".hud-player-chrome") as Element)
          .borderImageSource,
        level: getComputedStyle(document.querySelector(".hud-level-chrome") as Element).backgroundImage,
        pet: getComputedStyle(
          document.querySelector('[data-unit-kind="pet"] .hud-compact-chrome') as Element,
        ).backgroundImage,
        party: getComputedStyle(
          document.querySelector('[data-unit-kind="party"] .hud-compact-chrome') as Element,
        ).backgroundImage,
      }));

      if ((IMAGE_VARIANTS as readonly string[]).includes(themeId)) {
        expect(layers.player, themeId).toContain(`/assets/themes/${themeId}/player-chrome.webp`);
        expect(layers.level, themeId).toContain(`/assets/themes/${themeId}/level-medallion.webp`);
        expect(layers.pet, themeId).toContain(`/assets/themes/${themeId}/pet-frame.webp`);
        expect(layers.party, themeId).toContain(`/assets/themes/${themeId}/party-frame.webp`);
      } else {
        expect(layers.player, themeId).toBe("none");
        expect(layers.pet, themeId).toBe("none");
        expect(layers.party, themeId).toBe("none");
      }
    }
  });
});
