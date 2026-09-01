import { describe, expect, it } from "vitest";

import { createDefaultState } from "../../../src/shared/contracts/state";
import type { ChallengeUpdate } from "../../../src/shared/contracts/win-challenges";
import { discriminateCompositeMessage } from "../../../src/composite/wire";

const state = createDefaultState(
  { twitchUserId: "12345678901234567890", displayName: "Test" },
  "2026-08-31T12:00:00.000Z",
);

const challengeUpdate: ChallengeUpdate = {
  eventSeq: 1,
  boardRevision: 1,
  settingsRevision: 1,
  settings: {
    styleId: "plain-list",
    themeMode: "inherit",
    surfaceMode: "surface",
    headerTitle: "CHALLENGES",
    effectsEnabled: true,
    maxVisible: 5,
    overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end",
    themeId: "trail-wood",
    globalTimer: null,
    placement: { x: 30, y: 8, scale: 1 },
  },
  challenges: [],
  event: null,
};

describe("Composite-Wire-Diskriminierung", () => {
  it.each([
    [{ type: "snapshot", state }, "hud"],
    [{ type: "state_committed", state }, "hud"],
    [challengeUpdate, "challenges"],
    [{ type: "token_revoked" }, "token_revoked"],
  ] as const)("adressiert %s an %s", (input, kind) => {
    const parsed = discriminateCompositeMessage(input);
    expect(parsed.kind).toBe(kind);
    if (parsed.kind !== "ignore") expect(parsed.message).not.toBeNull();
  });

  it("verwirft unbekannte Nachrichten ohne Modulkontakt", () => {
    expect(discriminateCompositeMessage({ type: "time_sync", serverTime: "now" })).toEqual({ kind: "ignore" });
    expect(discriminateCompositeMessage({ eventSeq: 1, type: "unexpected" })).toEqual({ kind: "ignore" });
    expect(discriminateCompositeMessage("kein JSON")).toEqual({ kind: "ignore" });
  });

  it("meldet ein beschädigtes Paket nur an das vorher diskriminierte Modul", () => {
    expect(discriminateCompositeMessage({ type: "snapshot", state: {} })).toEqual({ kind: "hud", message: null });
    expect(discriminateCompositeMessage({ eventSeq: 1 })).toEqual({ kind: "challenges", message: null });
  });
});
