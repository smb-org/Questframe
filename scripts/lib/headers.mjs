// Ersetzt die Platzhalter in dist/client/_headers durch den öffentlichen Origin der
// gebauten Umgebung. Nötig, weil 'self' in einem sandboxed iframe mit opakem Origin
// (StreamElements-Custom-Widget) auf nichts mehr passt, der ausgeschriebene Origin
// dagegen schon.

// Der lokale "pnpm run build" kennt keine Umgebung und damit keine Route.
const LOCAL_HOST = "localhost:5173";

export const publicOriginFor = (config, environment) => {
  if (environment === undefined || environment === "") {
    return { origin: `http://${LOCAL_HOST}`, host: LOCAL_HOST };
  }
  const routes = config.env?.[environment]?.routes;
  const pattern = Array.isArray(routes) ? routes[0]?.pattern : undefined;
  if (typeof pattern !== "string" || pattern === "") {
    throw new Error(
      `wrangler.jsonc: env.${environment}.routes[0].pattern fehlt — ohne Custom Domain lässt sich der Origin nicht bestimmen.`,
    );
  }
  return { origin: `https://${pattern}`, host: pattern };
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
