import { chromium } from "@playwright/test";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const BASE_URL = "http://localhost:5173";
const OUTPUT_DIR = path.resolve("docs/images");
const MAX_FILE_BYTES = 1_000_000;
const VIEWPORT = { width: 1_200, height: 720 };

// Kommentar: Dieses Skript bereitet nur lokale README-Bilder vor und startet keinen Server.
const failWithServerHint = () => {
  throw new Error(
    `Der Dev-Server ist unter ${BASE_URL} nicht erreichbar. Bitte zuerst "pnpm run dev" starten.`,
  );
};

const ensureDevServer = async () => {
  try {
    const response = await fetch(`${BASE_URL}/`, {
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`);
    }
  } catch {
    failWithServerHint();
  }
};

// Siehe tests/e2e/support/socket-lifecycle.ts (installSocketLifecycle) fuer das
// Original samt Begruendung. Hier dupliziert, weil dieses Skript plain .mjs ist
// und nicht gegen @playwright/test-Typen laeuft; Verhalten muss identisch bleiben.
const installSocketLifecycle = async (context) => {
  await context.addInitScript(() => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets = new Set();
    const immediateCloses = new WeakMap();
    const trackedWebSocket = function (url, protocols) {
      const socket = new originalWebSocket(url, protocols);
      sockets.add(socket);
      const closeSocket = socket.close.bind(socket);
      immediateCloses.set(socket, closeSocket);
      // React StrictMode entsorgt den ersten Effekt oft noch waehrend CONNECTING.
      // Workerd sieht den Socket zuverlaessig als geschlossen, wenn der Handshake
      // erst beendet und danach der native Close gesendet wird.
      socket.close = (...args) => {
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.addEventListener("open", () => { closeSocket(...args); }, { once: true });
          return;
        }
        closeSocket(...args);
      };
      socket.addEventListener("close", () => sockets.delete(socket), { once: true });
      return socket;
    };
    trackedWebSocket.prototype = originalWebSocket.prototype;
    Object.setPrototypeOf(trackedWebSocket, originalWebSocket);
    const closeSockets = () => {
      for (const socket of sockets) {
        try {
          immediateCloses.get(socket)?.();
        } catch {
          // Ein bereits geschlossener Socket darf die restliche Bereinigung nicht blockieren.
        }
      }
    };
    globalThis.e2eSockets = sockets;
    globalThis.addEventListener("pagehide", closeSockets, { once: true });
    globalThis.WebSocket = trackedWebSocket;
  });
};

// Siehe tests/e2e/support/socket-lifecycle.ts (releaseTrackedSockets): hartes
// close() ohne vorheriges about:blank laesst hibernierende WebSockets im
// Durable Object haengen, bis MAX_EDITOR_SOCKETS erschoepft ist.
const releaseTrackedSockets = async (context) => {
  const pages = context.pages().filter((page) => !page.isClosed());
  await Promise.all(pages.map((page) =>
    page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 }).catch(() => null)
  ));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
};

const randomUuid = () => crypto.randomUUID();

const api = async (page, pathname, options = {}) => {
  const result = await page.evaluate(async ({ pathname: currentPath, options: currentOptions }) => {
    const response = await fetch(currentPath, {
      method: currentOptions.method ?? "GET",
      headers: currentOptions.headers,
      body: currentOptions.body,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`${currentOptions.method ?? "GET"} ${currentPath} fehlgeschlagen (${String(response.status)}): ${body}`);
    }
    if (body === "") return null;
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`${currentOptions.method ?? "GET"} ${currentPath} lieferte kein JSON.`);
    }
  }, { pathname, options });
  return result;
};

const readEditorContext = async (page) => {
  const tabId = await page.evaluate(() => sessionStorage.getItem("irl-stream-hud-editor-tab") ?? "");
  if (tabId === "") throw new Error("Die lokale Editor-Tab-ID fehlt nach der Anmeldung.");
  const bootstrap = await api(page, "/api/editor/bootstrap", {
    headers: { "x-editor-tab": tabId },
  });
  return { bootstrap, tabId };
};

const editorHeaders = (tabId, csrfToken) => ({
  "content-type": "application/json",
  "x-csrf-token": csrfToken,
  "x-editor-tab": tabId,
});

const uploadPortrait = async (page, tabId, csrfToken, filePath) => {
  const base64 = await readFile(filePath, { encoding: "base64" });
  const result = await page.evaluate(async ({ base64: currentBase64, tabId: currentTabId, csrfToken: currentCsrfToken }) => {
    const bytes = Uint8Array.from(atob(currentBase64), (char) => char.charCodeAt(0));
    const response = await fetch("/api/media", {
      method: "POST",
      headers: {
        "content-type": "image/webp",
        "x-csrf-token": currentCsrfToken,
        "x-editor-tab": currentTabId,
      },
      body: bytes,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`POST /api/media fehlgeschlagen (${String(response.status)}): ${body}`);
    }
    return JSON.parse(body);
  }, { base64, tabId, csrfToken });
  return result.portrait;
};

// Kommentar: Der Twitch-Gast im HUD muss auf eine ID zeigen, die bereits im
// twitch_user_cache steckt (sonst 422 "Twitch-Gast muss zuerst gesucht
// werden"). /auth/dev seedet genau den Broadcaster dort hinein, also nehmen
// wir dessen ID aus der Bootstrap-Antwort statt sie hart zu kodieren.
const resolveBroadcasterTwitchUserId = (bootstrap) => {
  const fromBootstrap = bootstrap?.capsule?.channel?.id;
  if (typeof fromBootstrap === "string" && fromBootstrap !== "") return fromBootstrap;
  const fallback = process.env.BROADCASTER_ID;
  if (typeof fallback === "string" && fallback !== "") return fallback;
  throw new Error(
    "Die Twitch-Broadcaster-ID fehlt in /api/editor/bootstrap (capsule.channel) und in process.env.BROADCASTER_ID ist kein Fallback gesetzt.",
  );
};

const createHudDraft = (state, playerPortrait, petPortrait, broadcasterTwitchUserId) => {
  const {
    revision: _revision,
    overlayEnabled: _overlayEnabled,
    updatedAt: _updatedAt,
    updatedBy: _updatedBy,
    ...draft
  } = state;
  void [_revision, _overlayEnabled, _updatedAt, _updatedBy];

  return {
    ...draft,
    themeId: "classic-simple",
    placement: { x: 12, y: 12, scale: 1 },
    player: {
      ...draft.player,
      name: "Streamer",
      title: "IRL-Abenteuer",
      level: 30,
      portrait: playerPortrait,
      hpPercent: 64,
      resource: { name: "Fokus", color: "#FF8040", percent: 72 },
    },
    pet: {
      name: "Fünkchen",
      subtitle: "Wegweiser",
      portrait: petPortrait,
      hpPercent: 84,
    },
    petVisible: true,
    compositeHudVisible: true,
    group: [
      {
        id: "fantasie-luma",
        source: "manual",
        twitchUserId: null,
        name: "Luma",
        portrait: { kind: "initials", text: "LU" },
        hpPercent: 78,
      },
      {
        id: "fantasie-taro",
        source: "manual",
        twitchUserId: null,
        name: "Taro",
        portrait: { kind: "initials", text: "TA" },
        hpPercent: 57,
      },
      {
        id: "twitch-gast",
        source: "twitch",
        twitchUserId: broadcasterTwitchUserId,
        // Kommentar: Name/Portrait sind Platzhalter — der Server überschreibt
        // beides beim Speichern aus twitch_user_cache (canonicalizeTwitchGroup).
        name: "Twitch-Gast",
        portrait: { kind: "initials", text: "TW" },
        hpPercent: 91,
      },
    ],
    groupVisible: true,
    compositeChallengesVisible: true,
    effects: [
      {
        id: "beispiel-gestaerkt",
        catalogId: "buff-gestaerkt",
        kind: "buff",
        name: "Gestärkt",
        description: "Bereit für das nächste Abenteuer.",
        iconId: "buff-gestaerkt",
        stacks: 1,
        expiresAt: null,
        order: 0,
      },
      {
        id: "beispiel-entdeckergeist",
        catalogId: "buff-entdeckergeist",
        kind: "buff",
        name: "Entdeckergeist",
        description: "Hinter der nächsten Kurve wartet etwas Neues.",
        iconId: "buff-entdeckergeist",
        stacks: 1,
        expiresAt: null,
        order: 1,
      },
      {
        id: "beispiel-rueckenwind",
        catalogId: "buff-rueckenwind",
        kind: "buff",
        name: "Rückenwind",
        description: "Heute trägt der Wind den Abenteurer voran.",
        iconId: "buff-rueckenwind",
        stacks: 1,
        expiresAt: null,
        order: 2,
      },
      {
        id: "beispiel-funkloch",
        catalogId: "debuff-funkloch",
        kind: "debuff",
        name: "Funkloch",
        description: "Die Verbindung kämpft mit der Wildnis.",
        iconId: "debuff-funkloch",
        stacks: 1,
        expiresAt: null,
        order: 3,
      },
    ],
    featuredEffectId: "beispiel-gestaerkt",
  };
};

const publishHudState = async (page, bootstrap, tabId) => {
  const playerPortrait = await uploadPortrait(
    page,
    tabId,
    bootstrap.csrfToken,
    path.resolve("scripts/screenshot-assets/player.webp"),
  );
  const petPortrait = await uploadPortrait(
    page,
    tabId,
    bootstrap.csrfToken,
    path.resolve("scripts/screenshot-assets/pet.webp"),
  );
  const state = createHudDraft(
    bootstrap.state,
    playerPortrait,
    petPortrait,
    resolveBroadcasterTwitchUserId(bootstrap),
  );
  return api(page, "/api/state", {
    method: "PUT",
    headers: editorHeaders(tabId, bootstrap.csrfToken),
    body: JSON.stringify({ baseRevision: bootstrap.state.revision, state }),
  });
};

const challengeDefinitions = () => [
  {
    clientId: randomUuid(),
    title: "10 km wandern",
    targetCount: 10,
    timerTotalMs: null,
    sortOrder: 0,
    hidden: false,
  },
  {
    clientId: randomUuid(),
    title: "Drei Zuschauer-Grussbotschaften",
    targetCount: 3,
    timerTotalMs: null,
    sortOrder: 1,
    hidden: false,
  },
  {
    clientId: randomUuid(),
    title: "Sonnenaufgang filmen",
    targetCount: null,
    timerTotalMs: null,
    sortOrder: 2,
    hidden: false,
  },
  {
    clientId: randomUuid(),
    title: "Picknickplatz entdecken",
    targetCount: null,
    timerTotalMs: null,
    sortOrder: 3,
    hidden: false,
  },
  {
    clientId: randomUuid(),
    title: "Gruppenfoto am Aussichtspunkt",
    targetCount: null,
    timerTotalMs: 180_000,
    sortOrder: 4,
    hidden: false,
  },
];

const publishChallengeBoard = async (page, tabId, csrfToken) => {
  const current = await api(page, "/api/challenges", {
    headers: { "x-editor-tab": tabId },
  });
  const challenges = challengeDefinitions();
  const saved = await api(page, "/api/challenges/board", {
    method: "PUT",
    headers: editorHeaders(tabId, csrfToken),
    body: JSON.stringify({ baseBoardRevision: current.boardRevision, challenges }),
  });

  const completedId = saved.createdIds[challenges[0].clientId];
  const timedId = saved.createdIds[challenges[4].clientId];
  if (typeof completedId !== "string" || typeof timedId !== "string") {
    throw new Error("Die Challenge-IDs wurden beim Speichern nicht zurückgegeben.");
  }

  await api(page, "/api/challenges/commands", {
    method: "POST",
    headers: editorHeaders(tabId, csrfToken),
    body: JSON.stringify({
      commandId: randomUuid(),
      scope: "challenge",
      type: "increment",
      challengeId: completedId,
      delta: 10,
    }),
  });
  await api(page, "/api/challenges/commands", {
    method: "POST",
    headers: editorHeaders(tabId, csrfToken),
    body: JSON.stringify({
      commandId: randomUuid(),
      scope: "challenge",
      type: "startTimer",
      challengeId: timedId,
    }),
  });
};

// Kommentar: Der Challenge-Log steht im Sammelbild rechts neben dem HUD.
// Gibt die vorherigen Settings zurueck, damit run() sie danach wiederherstellen
// kann - /api/challenges/settings ist geteilter, dauerhaft gespeicherter
// Server-Zustand, kein Wegwerf-State dieses Skripts (analog zum Socket-Leak:
// das Skript darf keine dauerhaften Spuren im lokalen Durable Object hinterlassen).
const configureChallengeView = async (page, tabId, csrfToken) => {
  const current = await api(page, "/api/challenges", {
    headers: { "x-editor-tab": tabId },
  });
  await api(page, "/api/challenges/settings", {
    method: "PUT",
    headers: editorHeaders(tabId, csrfToken),
    body: JSON.stringify({
      baseSettingsRevision: current.settingsRevision,
      styleId: "plain-list",
      themeMode: "inherit",
      surfaceMode: "surface",
      headerStyle: "default",
      headerTitle: "Win-Challenges",
      effectsEnabled: true,
      maxVisible: 5,
      overflowMode: "cut",
      overflowTempo: "medium",
      numbered: true,
      doneOrder: "end",
      globalTimerMode: "down",
      globalTimerTotalMs: null,
      placement: { x: 134, y: 12, scale: 1 },
    }),
  });
  return current.settings;
};

const restoreChallengeSettings = async (page, tabId, csrfToken, previousSettings) => {
  const current = await api(page, "/api/challenges", {
    headers: { "x-editor-tab": tabId },
  });
  await api(page, "/api/challenges/settings", {
    method: "PUT",
    headers: editorHeaders(tabId, csrfToken),
    body: JSON.stringify({
      baseSettingsRevision: current.settingsRevision,
      styleId: previousSettings.styleId,
      themeMode: previousSettings.themeMode,
      surfaceMode: previousSettings.surfaceMode,
      headerStyle: previousSettings.headerStyle,
      headerTitle: previousSettings.headerTitle,
      effectsEnabled: previousSettings.effectsEnabled,
      maxVisible: previousSettings.maxVisible,
      overflowMode: previousSettings.overflowMode,
      overflowTempo: previousSettings.overflowTempo,
      numbered: previousSettings.numbered,
      doneOrder: previousSettings.doneOrder,
      globalTimerMode: previousSettings.globalTimerMode,
      globalTimerTotalMs: previousSettings.globalTimer?.totalMs ?? null,
      placement: previousSettings.placement,
    }),
  });
};

const createOverlayToken = async (page, bootstrap, tabId) => {
  const current = bootstrap.capsule.overlayToken;
  const route = current.exists ? "/api/overlay-token/rotate" : "/api/overlay-token";
  const response = await api(page, route, {
    method: "POST",
    headers: editorHeaders(tabId, bootstrap.csrfToken),
    body: JSON.stringify({
      requestId: randomUuid(),
      expectedGeneration: current.generation,
    }),
  });
  if (typeof response?.token !== "string") throw new Error("Das Overlay-Token fehlt in der API-Antwort.");
  return response.token;
};

const waitForLoadedContent = async (page, selectors) => {
  for (const selector of selectors) {
    await page.locator(selector).first().waitFor({ state: "visible" });
  }
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready;
    await Promise.all([...globalThis.document.images].map((image) => image.complete
      ? Promise.resolve()
      : new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      })));
  });
};

// Kommentar: Der Präsentationshintergrund ersetzt die transparente OBS-Fläche nur im Screenshot.
const injectPresentationBackground = async (page) => {
  await page.addStyleTag({
    content: `
      html[data-surface],
      html[data-surface] body,
      html[data-surface] #root {
        background: linear-gradient(135deg, #17171b 0%, #24242b 100%) !important;
      }
    `,
  });
};

const occupiedBounds = async (page, selectors) => {
  const bounds = await page.evaluate((currentSelectors) => {
    const rects = currentSelectors
      .flatMap((selector) => [...globalThis.document.querySelectorAll(selector)])
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { left, top, right, bottom };
  }, selectors);
  if (bounds === null) throw new Error(`Kein sichtbarer Aufnahmebereich für ${selectors.join(", ")} gefunden.`);
  return bounds;
};

const capture = async (page, fileName, selectors) => {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("Der Screenshot-Kontext hat keinen Viewport.");

  for (const margin of [24, 16, 8, 0]) {
    const bounds = await occupiedBounds(page, selectors);
    const x = Math.max(0, bounds.left - margin);
    const y = Math.max(0, bounds.top - margin);
    const right = Math.min(viewport.width, bounds.right + margin);
    const bottom = Math.min(viewport.height, bounds.bottom + margin);
    const outputPath = path.join(OUTPUT_DIR, fileName);
    await page.screenshot({
      path: outputPath,
      clip: { x, y, width: right - x, height: bottom - y },
      type: "png",
    });
    const file = await stat(outputPath);
    if (file.size > MAX_FILE_BYTES) {
      if (margin === 0) throw new Error(`Screenshot ${fileName} überschreitet 1 MB.`);
      continue;
    }
    return outputPath;
  }
  throw new Error(`Screenshot ${fileName} konnte nicht geschrieben werden.`);
};

const run = async () => {
  await ensureDevServer();
  await mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  let context = null;
  let restoreSettings = null;
  try {
    context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
    });
    await installSocketLifecycle(context);
    const adminPage = await context.newPage();
    await adminPage.goto(`${BASE_URL}/auth/dev`, { waitUntil: "commit" });
    await adminPage.waitForURL(/\/admin$/);
    await adminPage.getByRole("tab", { name: "HUD" }).waitFor({ state: "visible" });

    const { bootstrap, tabId } = await readEditorContext(adminPage);
    await publishHudState(adminPage, bootstrap, tabId);
    await publishChallengeBoard(adminPage, tabId, bootstrap.csrfToken);
    const previousChallengeSettings = await configureChallengeView(adminPage, tabId, bootstrap.csrfToken);
    restoreSettings = () => restoreChallengeSettings(adminPage, tabId, bootstrap.csrfToken, previousChallengeSettings);
    const overlayToken = await createOverlayToken(adminPage, bootstrap, tabId);

    const capturePage = await context.newPage();
    const files = [];

    await capturePage.goto(`${BASE_URL}/overlay#token=${overlayToken}`, { waitUntil: "domcontentloaded" });
    await waitForLoadedContent(capturePage, [".hud-stage", '[role="meter"]']);
    await injectPresentationBackground(capturePage);
    files.push(await capture(capturePage, "hud.png", [".hud-stage"]));

    await capturePage.goto(`${BASE_URL}/overlay/challenges#token=${overlayToken}`, { waitUntil: "domcontentloaded" });
    await waitForLoadedContent(capturePage, [".challenge-source", ".challenge-source__row", ".challenge-source__row--done", ".challenge-source__time"]);
    await injectPresentationBackground(capturePage);
    files.push(await capture(capturePage, "win-challenge.png", [".challenge-source"]));

    await capturePage.goto(`${BASE_URL}/overlay/all#token=${overlayToken}`, { waitUntil: "domcontentloaded" });
    await waitForLoadedContent(capturePage, [".composite-source", ".hud-stage", ".challenge-source", ".challenge-source__row--done", ".challenge-source__time"]);
    await injectPresentationBackground(capturePage);
    files.push(await capture(capturePage, "overlay-all.png", [".hud-stage", ".challenge-source"]));

    console.log("Geschriebene Dateien:");
    for (const filePath of files) {
      const file = await stat(filePath);
      console.log(`- ${path.relative(process.cwd(), filePath)} (${(file.size / 1024).toFixed(1)} KB)`);
    }
  } finally {
    if (restoreSettings !== null) {
      // Darf einen Fehler aus dem try-Block nicht verdecken; best effort.
      await restoreSettings().catch((error) => {
        console.error(`Wiederherstellen der Challenge-Settings fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (context !== null) {
      await releaseTrackedSockets(context);
      await context.close();
    }
    await browser.close();
  }
};

try {
  await run();
} catch (error) {
  console.error(`Screenshot-Erzeugung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
