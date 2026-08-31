// Gemeinsame Bausteine für die WebSocket-Reconnect- und Reload-Watchdog-Logik
// der Overlay-/Live-Flächen (OverlayApp, CompositeApp, ChallengeSourceApp,
// LiveApp). Die drei Watchdog-Flächen haben BEWUSST unterschiedliche
// Selbstheilungs-Semantik (Overlay: ein Reload-Versuch pro Störung;
// ChallengeSourceApp: zeitstempelbasierte 5-Minuten-Sperre; CompositeApp:
// Reload nur wenn beide Module unparsbar sind, ebenfalls mit 5-Minuten-Sperre).
// Dieses Modul parametrisiert nur das tatsächlich Gemeinsame — Marker-Ablage
// und Backoff-Formel — ohne diese Unterschiede einzuebnen. Die jeweilige
// Watchdog-Ablaufsteuerung (wann geplant, wann abgebrochen, wann zurückgesetzt)
// bleibt bewusst in der jeweiligen App.

const RETRY_BASE_MS = 750;
const RETRY_MAX_MS = 30_000;

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
