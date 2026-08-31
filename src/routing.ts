export type Surface = "overlay" | "challenges" | "composite" | "live" | "admin";

export type RouteApp = "overlay" | "challenges" | "composite" | "live" | "login" | "admin";

export type AdminWorkspace = "hud" | "challenges";

export type RouteResolution = {
  surface: Surface;
  app: RouteApp;
  workspace: AdminWorkspace;
};

type RouteRule = RouteResolution & {
  path: string;
};

const ROUTES = [
  { path: "/admin/challenges", surface: "admin", app: "admin", workspace: "challenges" },
  { path: "/admin/composition", surface: "admin", app: "admin", workspace: "hud" },
  { path: "/admin", surface: "admin", app: "admin", workspace: "hud" },
  { path: "/overlay/all", surface: "composite", app: "composite", workspace: "hud" },
  // Die Challenge-Quelle muss vor /overlay stehen, sonst würde ihr Pfad im HUD landen.
  { path: "/overlay/challenges", surface: "challenges", app: "challenges", workspace: "hud" },
  { path: "/overlay", surface: "overlay", app: "overlay", workspace: "hud" },
  { path: "/live/challenges", surface: "live", app: "live", workspace: "hud" },
  { path: "/login", surface: "admin", app: "login", workspace: "hud" },
] as const satisfies readonly RouteRule[];

const matchesRoute = (path: string, routePath: string): boolean =>
  path === routePath || path.startsWith(`${routePath}/`);

export const resolveRoute = (path: string): RouteResolution => {
  const route = ROUTES.find((candidate) => matchesRoute(path, candidate.path));
  if (route !== undefined) {
    return { surface: route.surface, app: route.app, workspace: route.workspace };
  }
  return { surface: "admin", app: "admin", workspace: "hud" };
};

// Alte Admin-Unterseiten, die auf das zusammengelegte /admin umgeleitet
// werden. Kanonische Quelle ist ROUTES: nur die früheren eigenständigen
// Admin-Routen (app "admin", ohne "/admin" selbst und ohne "/login") gelten
// als Redirect-Ziel. Bewusst nur Exakttreffer (mit oder ohne einen
// Trailing-Slash) statt matchesRoute()s Subpfad-Erkennung — sonst würde z.B.
// "/admin/composition/foo" seinen Suffix beim Redirect verlieren, was das
// alte main.tsx-Verhalten nicht tat. Liefert null, wenn `path` keine solche
// Alt-Adresse ist.
export const canonicalAdminRedirectFor = (path: string): string | null => {
  const isOldAdminSubroute = ROUTES.some((candidate) =>
    candidate.app === "admin"
    && candidate.path !== "/admin"
    && (path === candidate.path || path === `${candidate.path}/`));
  return isOldAdminSubroute ? "/admin" : null;
};
