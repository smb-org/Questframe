export type Surface = "overlay" | "challenges" | "live" | "admin";

export type RouteApp = "overlay" | "challenges" | "live" | "login" | "admin";

export type RouteResolution = {
  surface: Surface;
  app: RouteApp;
};

type RouteRule = RouteResolution & {
  path: string;
};

const ROUTES = [
  // Die Challenge-Quelle muss vor /overlay stehen, sonst würde ihr Pfad im HUD landen.
  { path: "/overlay/challenges", surface: "challenges", app: "challenges" },
  { path: "/overlay", surface: "overlay", app: "overlay" },
  { path: "/live/challenges", surface: "live", app: "live" },
  { path: "/login", surface: "admin", app: "login" },
] as const satisfies readonly RouteRule[];

const matchesRoute = (path: string, routePath: string): boolean =>
  path === routePath || path.startsWith(`${routePath}/`);

export const resolveRoute = (path: string): RouteResolution => {
  const route = ROUTES.find((candidate) => matchesRoute(path, candidate.path));
  if (route !== undefined) {
    return { surface: route.surface, app: route.app };
  }
  return { surface: "admin", app: "admin" };
};
