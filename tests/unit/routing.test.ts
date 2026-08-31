import { describe, expect, it } from "vitest";

import { canonicalAdminRedirectFor, resolveRoute } from "../../src/routing";

describe("Routenauflösung", () => {
  it.each([
    ["/overlay/all", { surface: "composite", app: "composite", workspace: "hud" }],
    ["/overlay/all/", { surface: "composite", app: "composite", workspace: "hud" }],
    ["/overlay/challenges", { surface: "challenges", app: "challenges", workspace: "hud" }],
    ["/overlay/challenges/", { surface: "challenges", app: "challenges", workspace: "hud" }],
    ["/overlay", { surface: "overlay", app: "overlay", workspace: "hud" }],
    ["/overlay/", { surface: "overlay", app: "overlay", workspace: "hud" }],
    ["/overlaychallenges", { surface: "admin", app: "admin", workspace: "hud" }],
    ["/live/challenges", { surface: "live", app: "live", workspace: "hud" }],
    ["/login", { surface: "admin", app: "login", workspace: "hud" }],
    ["/", { surface: "admin", app: "admin", workspace: "hud" }],
    ["/admin", { surface: "admin", app: "admin", workspace: "hud" }],
    ["/admin/composition", { surface: "admin", app: "admin", workspace: "hud" }],
    ["/admin/composition/", { surface: "admin", app: "admin", workspace: "hud" }],
    ["/admin/challenges", { surface: "admin", app: "admin", workspace: "challenges" }],
    ["/unbekannt", { surface: "admin", app: "admin", workspace: "hud" }],
  ])("ordnet %s korrekt zu", (path, expected) => {
    expect(resolveRoute(path)).toEqual(expected);
  });
});

describe("canonicalAdminRedirectFor", () => {
  it.each([
    ["/admin/composition", "/admin"],
    ["/admin/composition/", "/admin"],
    ["/admin/challenges", "/admin"],
    ["/admin/challenges/", "/admin"],
  ])("leitet %s auf %s um", (path, expected) => {
    expect(canonicalAdminRedirectFor(path)).toBe(expected);
  });

  it.each([
    "/admin",
    "/admin/",
    "/admin/composition/foo",
    "/login",
    "/overlay",
    "/unbekannt",
  ])("liefert für %s null (kein Redirect)", (path) => {
    expect(canonicalAdminRedirectFor(path)).toBeNull();
  });
});
