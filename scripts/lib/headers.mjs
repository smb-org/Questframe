// Ersetzt die Platzhalter in dist/client/_headers durch den öffentlichen Origin der
// gebauten Umgebung. Nötig, weil 'self' in einem sandboxed iframe mit opakem Origin
// (StreamElements-Custom-Widget) auf nichts mehr passt, der ausgeschriebene Origin
// dagegen schon.

// Der lokale "pnpm run build" kennt keine Umgebung und braucht deshalb keinen
// öffentlichen Origin.
const LOCAL_HOST = "localhost:5173";

export const publicOriginFor = (environment, publicOrigin) => {
  if (environment === undefined || environment === "") {
    return { origin: `http://${LOCAL_HOST}`, host: LOCAL_HOST };
  }

  if (typeof publicOrigin !== "string" || publicOrigin.trim() === "") {
    throw new Error(
      `PUBLIC_ORIGIN fehlt für die Umgebung ${environment} — für den Build muss ein öffentlicher HTTPS-Origin gesetzt sein.`,
    );
  }

  let parsed;
  try {
    parsed = new URL(publicOrigin);
  } catch {
    throw new Error(
      "PUBLIC_ORIGIN muss eine gültige HTTPS-URL ohne Pfad oder Zugangsdaten sein.",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "PUBLIC_ORIGIN muss eine gültige HTTPS-URL ohne Pfad oder Zugangsdaten sein.",
    );
  }

  return { origin: parsed.origin, host: parsed.host };
};

export const renderHeaders = (source, { origin, host }) => {
  const rendered = source
    .replaceAll("__PUBLIC_ORIGIN__", origin)
    .replaceAll("__PUBLIC_HOST__", host);
  if (rendered.includes("__PUBLIC_")) {
    throw new Error("public/_headers enthält einen unbekannten __PUBLIC_*-Platzhalter.");
  }
  return rendered;
};
