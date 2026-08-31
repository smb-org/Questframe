import { describe, expect, it } from "vitest";

import { resolveRoute } from "../../src/routing";

describe("Routenauflösung", () => {
  it.each([
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
