// Gemeinsame Bausteine für die WebSocket-Reconnect- und Reload-Watchdog-Logik
// der Overlay-/Live-Flächen (OverlayApp, CompositeApp, ChallengeSourceApp,
// LiveApp). Die drei Watchdog-Flächen haben BEWUSST unterschiedliche
// Selbstheilungs-Semantik (Overlay: ein Reload-Versuch pro Störung;
// ChallengeSourceApp: zeitstempelbasierte 5-Minuten-Sperre; CompositeApp:
// Reload wenn beide Module gleichzeitig unparsbar sind ODER ein einzelnes
// Modul dauerhaft über eine Schwelle hinweg unparsbar bleibt, ebenfalls mit
// 5-Minuten-Sperre).
// Dieses Modul parametrisiert nur das tatsächlich Gemeinsame — Marker-Ablage
// und Backoff-Formel — ohne diese Unterschiede einzuebnen. Die jeweilige
// Watchdog-Ablaufsteuerung (wann geplant, wann abgebrochen, wann zurückgesetzt)
// bleibt bewusst in der jeweiligen App.

const RETRY_BASE_MS = 750;
const RETRY_MAX_MS = 30_000;

// Der Server lässt 70s ohne Ping zu (siehe SOCKET_STALE_AFTER_MS im Durable
// Object); drei ausgefallene 20s-Intervalle bleiben damit ohne Fehlalarm erlaubt.
export const SOCKET_PING_INTERVAL_MS = 20_000;

/**
 * Sendet regelmäßig "ping", damit das Durable Object verwaiste Verbindungen von
 * lebenden unterscheiden kann. Die Laufzeit beantwortet den Ping selbst, das
 * Objekt wacht dafür nicht auf.
 *
 * Hintergrund-Tabs drosseln setInterval auf etwa einen Aufruf pro Minute, und ein
 * zurückgeholter Tab soll nicht erst das nächste Intervall abwarten — deshalb der
 * zusätzliche Ping bei jedem Sichtbarwerden. Die Verfallsgrenze im Durable Object
 * (SOCKET_STALE_AFTER_MS) ist entsprechend großzügig bemessen.
 *
 * Bewusst wird NICHT sofort beim Start gepingt: ein Ping, der direkt auf das
 * "open"-Ereignis folgt, trifft das Durable Object, bevor es die Verbindung
 * fertig eingerichtet hat, und die Quelle blieb daraufhin leer (in den e2e-Tests
 * reproduzierbar). Nötig ist er auch nicht — eine Verbindung ohne Zeitstempel
 * gilt nie als verwaist, das erste Intervall ist also gedeckt.
 */
export const startSocketHeartbeat = (
  socket: WebSocket,
  intervalMs = SOCKET_PING_INTERVAL_MS,
): (() => void) => {
  const ping = () => {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send("ping");
    } catch {
      // Ein einzelner Sendefehler darf den Heartbeat-Timer nicht beenden.
    }
  };
  const timer = window.setInterval(ping, intervalMs);
  const onVisible = () => {
    if (document.visibilityState === "visible") ping();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
};

/** Reconnect-Backoff mit Jitter: min(30s, 750ms * 2^retry) + Zufallsanteil. */
export const nextReconnectDelayMs = (retry: number): number =>
  Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** retry) + Math.floor(Math.random() * 400);

export const reloadWindow = (): void => {
  window.location.reload();
};

/**
 * Prüft, ob unter `key` bereits ein Reload-Marker steht.
 * - Ohne `cooldownMs`: reine Existenzprüfung (Overlay-Semantik — höchstens
 *   ein Reload-Versuch, bis der Marker explizit wieder gelöscht wird).
 * - Mit `cooldownMs`: zeitstempelbasierte Sperre (Composite-/Challenge-
 *   Semantik — der Marker verfällt nach Ablauf der Cooldown-Frist von selbst).
 */
export const hasWatchdogReloadMarker = (key: string, cooldownMs?: number): boolean => {
  try {
    const stored = window.sessionStorage.getItem(key);
    if (cooldownMs === undefined) return stored !== null;
    const lastReloadAt = stored === null ? null : Number(stored);
    return lastReloadAt !== null
      && Number.isFinite(lastReloadAt)
      && Date.now() - lastReloadAt <= cooldownMs;
  } catch {
    return false;
  }
};

export const markWatchdogReload = (key: string): boolean => {
  try {
    window.sessionStorage.setItem(key, String(Date.now()));
    return true;
  } catch {
    // Ohne persistenten Marker nicht reloaden: eine blockierte Storage-API darf
    // keinen dauerhaften Reload-Sturm in der OBS-Browserquelle auslösen.
    return false;
  }
};

export const clearWatchdogReloadMarker = (key: string): void => {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Session-Storage ist optional; ein fehlender Marker ist kein Fehler.
  }
};
