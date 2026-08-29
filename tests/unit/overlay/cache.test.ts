import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../../src/shared/contracts/state";
import {
  cacheKeyFor,
  fingerprintOverlayToken,
  loadOverlaySnapshot,
  removeOverlaySnapshot,
  storeOverlaySnapshot,
} from "../../../src/overlay/cache";

describe("overlay recovery cache", () => {
  it("isolates snapshots by schema, capsule and token fingerprint", async () => {
    const fingerprint = await fingerprintOverlayToken("A".repeat(43));
    expect(fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(cacheKeyFor("irl-stream-hud", fingerprint)).toBe(`hud:1:irl-stream-hud:${fingerprint}`);

    const state = createDefaultState(
      { twitchUserId: "123", displayName: "Moderator" },
      "2026-08-29T12:00:00.000Z",
    );
    storeOverlaySnapshot("irl-stream-hud", fingerprint, state);
    expect(loadOverlaySnapshot("irl-stream-hud", fingerprint)).toEqual(state);
    expect(loadOverlaySnapshot("other", fingerprint)).toBeNull();
    removeOverlaySnapshot("irl-stream-hud", fingerprint);
    expect(loadOverlaySnapshot("irl-stream-hud", fingerprint)).toBeNull();
  });

  it("fails closed on malformed or incompatible cached JSON", () => {
    localStorage.setItem("hud:1:irl-stream-hud:broken", "not-json");
    expect(loadOverlaySnapshot("irl-stream-hud", "broken")).toBeNull();
    expect(localStorage.getItem("hud:1:irl-stream-hud:broken")).toBeNull();
  });
});
