import { expect, test, type BrowserContext, type Page } from "@playwright/test";

type EditorBootstrap = {
  capsule: {
    overlayToken: { token: string | null };
    dockToken?: { token: string | null };
  };
  csrfToken: string;
};

type ChallengeSnapshot = {
  boardRevision: number;
};

type ChallengeSourceWindow = Window & {
  e2eChallengeSocket?: WebSocket;
};

type ChallengeTestWindow = Window & {
  e2eSockets?: Set<WebSocket>;
};

const loginAsLocalEditor = async (page: Page) => {
  await page.goto("/auth/dev", { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/admin$/);
};

const editorTabId = async (page: Page): Promise<string> =>
  page.evaluate(() => sessionStorage.getItem("irl-stream-hud-editor-tab") ?? "");

const readEditorBootstrap = async (page: Page): Promise<EditorBootstrap> =>
  page.evaluate(async () => {
    const tabId = sessionStorage.getItem("irl-stream-hud-editor-tab") ?? "";
    const response = await fetch("/api/editor/bootstrap", { headers: { "x-editor-tab": tabId } });
    if (!response.ok) throw new Error(`Bootstrap fehlgeschlagen: ${String(response.status)}`);
    return response.json<EditorBootstrap>();
  });

const readChallengeSnapshot = async (page: Page, tabId: string): Promise<ChallengeSnapshot> =>
  page.evaluate(async (currentTabId) => {
    const response = await fetch("/api/challenges", { headers: { "x-editor-tab": currentTabId } });
    if (!response.ok) throw new Error(`Challenge-Board fehlgeschlagen: ${String(response.status)}`);
    return response.json<ChallengeSnapshot>();
  }, tabId);

const resetChallengeBoard = async (page: Page): Promise<void> => {
  const bootstrap = await readEditorBootstrap(page);
  const tabId = await editorTabId(page);
  const snapshot = await readChallengeSnapshot(page, tabId);
  const result = await page.evaluate(async ({ csrfToken, currentTabId, boardRevision }) => {
    const response = await fetch("/api/challenges/board", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
        "x-editor-tab": currentTabId,
      },
      body: JSON.stringify({ baseBoardRevision: boardRevision, challenges: [] }),
    });
    return { body: await response.text(), ok: response.ok, status: response.status };
  }, { boardRevision: snapshot.boardRevision, csrfToken: bootstrap.csrfToken, currentTabId: tabId });
  expect(result.ok, `${String(result.status)} ${result.body}`).toBe(true);
};

const openChallengeAdmin = async (page: Page): Promise<void> => {
  await loginAsLocalEditor(page);
  await page.goto("/admin/challenges");
  await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();
  await expect(page.locator(".challenge-board-shell .connection-state.is-online")).toBeVisible();
  await resetChallengeBoard(page);
  await expect(page.locator(".challenge-board-row")).toHaveCount(0);
};

const readOverlayToken = async (page: Page): Promise<string | null> => {
  const bootstrap = await readEditorBootstrap(page);
  return bootstrap.capsule.overlayToken.token;
};

const readDockToken = async (page: Page): Promise<string | null> => {
  const bootstrap = await readEditorBootstrap(page);
  return bootstrap.capsule.dockToken?.token ?? null;
};

const ensureOverlayToken = async (page: Page): Promise<string> => {
  const currentToken = await readOverlayToken(page);
  if (currentToken !== null) return currentToken;
  const source = page.locator(".challenge-setup__source--hud");
  const button = source.getByRole("button", { name: /OBS-Link erzeugen|Token ersetzen/ });
  await button.click();
  await expect.poll(() => readOverlayToken(page)).not.toBeNull();
  const token = await readOverlayToken(page);
  if (token === null) throw new Error("Overlay-Token fehlt trotz erfolgreicher Erzeugung.");
  return token;
};

const ensureDockToken = async (page: Page): Promise<string> => {
  const currentToken = await readDockToken(page);
  if (currentToken !== null) return currentToken;
  const source = page.locator(".challenge-setup__source--live");
  const button = source.getByRole("button", { name: /Dock-Link erzeugen|Token ersetzen/ });
  await button.click();
  await expect.poll(() => readDockToken(page)).not.toBeNull();
  const token = await readDockToken(page);
  if (token === null) throw new Error("Dock-Token fehlt trotz erfolgreicher Erzeugung.");
  return token;
};

const createChallenge = async (page: Page, title: string, targetCount?: number): Promise<void> => {
  await page.getByRole("button", { name: "Challenge anlegen" }).click();
  const row = page.locator(".challenge-board-row").last();
  await row.getByLabel("Titel").fill(title);
  if (targetCount !== undefined) {
    await row.getByRole("checkbox", { name: `${title} mit Zielwert` }).check();
    await row.getByRole("spinbutton", { name: `${title} Zielwert` }).fill(String(targetCount));
  }
  await page.getByRole("button", { name: "Challenge-Board speichern" }).click();
  await expect(page.getByText(/Board gespeichert · Revision \d+\./)).toBeVisible();
};

const challengeRow = (page: Page, title: string) =>
  page.locator(".challenge-source__row").filter({ hasText: title });

const disposePage = async (page: Page): Promise<void> => {
  if (page.isClosed()) return;
  try {
    await page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 });
  } catch {
    // Auch wenn die Navigation scheitert, muss die Seite geschlossen werden.
  }
  if (!page.isClosed()) await page.close().catch(() => undefined);
};

const disposeContextPages = async (context: BrowserContext): Promise<void> => {
  await Promise.all(context.pages().map(disposePage));
};

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    const originalWebSocket = window.WebSocket;
    const sockets = new Set<WebSocket>();
    const immediateCloses = new WeakMap<WebSocket, () => void>();
    const trackedWebSocket = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const socket = new originalWebSocket(url, protocols);
      sockets.add(socket);
      const closeSocket = socket.close.bind(socket);
      immediateCloses.set(socket, closeSocket);
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
    (window as ChallengeTestWindow).e2eSockets = sockets;
    window.addEventListener("pagehide", () => {
      for (const socket of sockets) immediateCloses.get(socket)?.();
    }, { once: true });
    window.WebSocket = trackedWebSocket as unknown as typeof WebSocket;
  });
});

// Auch nach einem fehlgeschlagenen Test muessen alle Seiten und ihre Sockets geschlossen sein.
test.afterEach(async ({ context }) => {
  await disposeContextPages(context);
  // Der Context beendet auch verbliebene Browser-Socket-Zustaende zuverlässig.
  await context.close();
  // Der lokale Worker verarbeitet den WebSocket-Close asynchron.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
});

test("eine neue Board-Challenge erscheint in der Challenge-Quelle", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-Challenge-Quelle");
  await openChallengeAdmin(page);
  const overlayToken = await ensureOverlayToken(page);
  const source = await context.newPage();
  await source.goto(`/overlay/challenges#token=${overlayToken}`);

  const title = "E2E Board Quelle";
  await createChallenge(page, title);
  await expect(challengeRow(source, title)).toHaveCount(1);
  await expect(challengeRow(source, title).getByText(title, { exact: true })).toBeVisible();
  await disposePage(source);
  await disposePage(page);
});

test("ein Live-Plus erhöht den Stand in der Challenge-Quelle", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-Live-Challenge");
  await openChallengeAdmin(page);
  const overlayToken = await ensureOverlayToken(page);
  const dockToken = await ensureDockToken(page);
  const title = "E2E Live Zaehler";
  await createChallenge(page, title, 3);

  const source = await context.newPage();
  await source.goto(`/overlay/challenges#token=${overlayToken}`);
  const live = await context.newPage();
  await live.goto(`/live/challenges#token=${dockToken}`);
  await expect(challengeRow(source, title).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  await expect(live.getByRole("button", { name: `${title} um 1 erhöhen` })).toBeVisible();

  await live.getByRole("button", { name: `${title} um 1 erhöhen` }).click();
  await expect(challengeRow(source, title).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
  await disposePage(live);
  await disposePage(source);
  await disposePage(page);
});

test("zwei parallele Inkremente werden addiert", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-Atomaritaet");
  await openChallengeAdmin(page);
  const overlayToken = await ensureOverlayToken(page);
  const dockToken = await ensureDockToken(page);
  const title = "E2E Parallele Summe";
  await createChallenge(page, title, 5);

  const source = await context.newPage();
  await source.goto(`/overlay/challenges#token=${overlayToken}`);
  const live = await context.newPage();
  await live.goto(`/live/challenges#token=${dockToken}`);
  const row = challengeRow(source, title);
  await expect(row.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  const challengeId = await row.getAttribute("data-challenge-id");
  if (challengeId === null) throw new Error("Challenge-ID fehlt in der Quelle.");

  const statuses = await live.evaluate(async ({ challengeId: currentChallengeId, token }) => {
    const send = (commandId: string) => fetch("/api/challenges/commands", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        commandId,
        scope: "challenge",
        type: "increment",
        challengeId: currentChallengeId,
        delta: 1,
      }),
    });
    const [first, second] = await Promise.all([
      send(crypto.randomUUID()),
      send(crypto.randomUUID()),
    ]);
    return await Promise.all([first, second].map(async (response) => ({
      body: await response.text(),
      status: response.status,
    })));
  }, { challengeId, token: dockToken });
  expect(statuses.map((result) => result.status), JSON.stringify(statuses)).toEqual([200, 200]);
  await expect(row.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
  await disposePage(live);
  await disposePage(source);
  await disposePage(page);
});

test("ein kaputtes Challenge-Update blendet nur das Log aus", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-Quellen-Isolation");
  await openChallengeAdmin(page);
  const overlayToken = await ensureOverlayToken(page);
  const title = "E2E Stoerung Isolation";
  await createChallenge(page, title);

  const hud = await context.newPage();
  const navigationKey = `e2e-hud-navigation-${testInfo.testId}`;
  await hud.addInitScript((key) => {
    const previous = Number(sessionStorage.getItem(key) ?? "0");
    sessionStorage.setItem(key, String(previous + 1));
  }, navigationKey);
  await hud.goto(`/overlay#token=${overlayToken}`);
  const hudHealth = hud.getByRole("meter", { name: /Gesundheit \d+ Prozent/ }).first();
  await expect(hudHealth).toBeVisible();
  const navigationCount = await hud.evaluate((key) => sessionStorage.getItem(key), navigationKey);
  const healthBefore = await hudHealth.getAttribute("aria-valuenow");

  const source = await context.newPage();
  await source.addInitScript(() => {
    const originalWebSocket = window.WebSocket;
    const wrappedWebSocket = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const socket = new originalWebSocket(url, protocols);
      (window as ChallengeSourceWindow).e2eChallengeSocket = socket;
      return socket;
    };
    wrappedWebSocket.prototype = originalWebSocket.prototype;
    Object.setPrototypeOf(wrappedWebSocket, originalWebSocket);
    window.WebSocket = wrappedWebSocket as unknown as typeof WebSocket;
  });
  await source.goto(`/overlay/challenges#token=${overlayToken}`);
  await expect(challengeRow(source, title)).toHaveCount(1);
  await source.evaluate(() => {
    const socket = (window as ChallengeSourceWindow).e2eChallengeSocket;
    if (socket === undefined) throw new Error("Challenge-WebSocket fehlt.");
    socket.dispatchEvent(new MessageEvent("message", { data: "ungültige Challenge-Nachricht" }));
  });
  await expect(source.locator('[aria-label="Challenge-Quelle"]')).toHaveCount(0);
  await expect(hudHealth).toBeVisible();
  await expect(hudHealth).toHaveAttribute("aria-valuenow", healthBefore ?? "");
  await expect.poll(() => hud.evaluate((key) => sessionStorage.getItem(key), navigationKey)).toBe(navigationCount);
  await disposePage(source);
  await disposePage(hud);
  await disposePage(page);
});
