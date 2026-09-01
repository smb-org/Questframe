import type { BrowserContext, TestInfo } from "@playwright/test";

type SocketTrackingWindow = Window & {
  e2eSockets?: Set<WebSocket>;
};

export const installSocketLifecycle = async (context: BrowserContext): Promise<void> => {
  await context.addInitScript(() => {
    const originalWebSocket = window.WebSocket;
    const sockets = new Set<WebSocket>();
    const immediateCloses = new WeakMap<WebSocket, () => void>();
    const trackedWebSocket = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
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
    const trackingWindow = window as SocketTrackingWindow;
    trackingWindow.e2eSockets = sockets;
    window.addEventListener("pagehide", closeSockets, { once: true });
    window.WebSocket = trackedWebSocket as unknown as typeof WebSocket;
  });
};

export const releaseTrackedSockets = async (context: BrowserContext, testInfo: TestInfo): Promise<void> => {
  const pages = context.pages().filter((page) => !page.isClosed());
  const socketCounts = await Promise.all(pages.map((page) => page.evaluate(() =>
    (window as SocketTrackingWindow).e2eSockets?.size ?? 0
  ).catch(() => 0)));
  if (testInfo.status !== testInfo.expectedStatus) {
    await Promise.all(pages.map(async (page, index) => {
      const body = await page.screenshot({ fullPage: true }).catch(() => null);
      if (body !== null) {
        await testInfo.attach(`failure-before-socket-cleanup-${String(index + 1)}`, {
          body,
          contentType: "image/png",
        });
      }
    }));
  }
  await Promise.all(pages.map((page) =>
    page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 }).catch(() => null)
  ));
  if (!socketCounts.some((count) => count > 0)) return;
  // Der lokale Durable Object entfernt geschlossene Hibernation-Sockets
  // asynchron aus dem kanalweiten Editor-Limit.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
};
