export type Surface = "overlay" | "challenges" | "live" | "admin";

export type RouteApp = "overlay" | "challenges" | "live" | "login" | "admin";

export type AdminWorkspace = "hud" | "composition" | "challenges";

export type RouteResolution = {
  surface: Surface;
  app: RouteApp;
  workspace: AdminWorkspace;
};

type RouteRule = RouteResolution & {
  path: string;
};

const ROUTES = [
  { path: "/admin/composition", surface: "admin", app: "admin", workspace: "composition" },
  { path: "/admin/challenges", surface: "admin", app: "admin", workspace: "challenges" },
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
