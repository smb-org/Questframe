import { describe, expect, it } from "vitest";

import { resolveRoute } from "../../src/routing";

describe("Routenauflösung", () => {
  it.each([
    ["/overlay/challenges", { surface: "challenges", app: "challenges" }],
    ["/overlay/challenges/", { surface: "challenges", app: "challenges" }],
    ["/overlay", { surface: "overlay", app: "overlay" }],
    ["/overlay/", { surface: "overlay", app: "overlay" }],
    ["/overlaychallenges", { surface: "admin", app: "admin" }],
    ["/live/challenges", { surface: "live", app: "live" }],
    ["/login", { surface: "admin", app: "login" }],
    ["/", { surface: "admin", app: "admin" }],
    ["/admin", { surface: "admin", app: "admin" }],
    ["/unbekannt", { surface: "admin", app: "admin" }],
  ])("ordnet %s korrekt zu", (path, expected) => {
    expect(resolveRoute(path)).toEqual(expected);
  });
});
