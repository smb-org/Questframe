import { afterEach, describe, expect, it, vi } from "vitest";

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

  describe("with a blocked localStorage", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("loadOverlaySnapshot returns null instead of throwing when getItem throws", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
      expect(loadOverlaySnapshot("irl-stream-hud", "fingerprint")).toBeNull();
    });

    it("storeOverlaySnapshot swallows a throwing setItem instead of crashing the app", async () => {
      const fingerprint = await fingerprintOverlayToken("A".repeat(43));
      const state = createDefaultState(
        { twitchUserId: "123", displayName: "Moderator" },
        "2026-08-29T12:00:00.000Z",
      );
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
      expect(() => {
        storeOverlaySnapshot("irl-stream-hud", fingerprint, state);
      }).not.toThrow();
    });

    it("removeOverlaySnapshot swallows a throwing removeItem instead of crashing the app", () => {
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
      expect(() => {
        removeOverlaySnapshot("irl-stream-hud", "fingerprint");
      }).not.toThrow();
    });

    it("loadOverlaySnapshot returns null when the removal-on-failure cleanup itself throws", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => "not-json");
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
      expect(loadOverlaySnapshot("irl-stream-hud", "broken")).toBeNull();
    });
  });
});
