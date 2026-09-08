import { describe, expect, it } from "vitest";

import {
  MAX_OVERLAY_SOCKETS,
  bootstrapResponseSchema,
  createApiError,
  overlayTokenMutationRequestSchema,
  overlayTokenResponseSchema,
  overlayTokenStatusSchema,
  saveRequestSchema,
  serverMessageSchema,
  visibilityRequestSchema,
} from "../../../src/shared/contracts/api";
import { createDefaultState } from "../../../src/shared/contracts/state";

const actor = { twitchUserId: "12345678901234567890", displayName: "Moderator" };

describe("API contracts", () => {
  it("parses complete save requests and never accepts overlay visibility in a draft", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const { revision, overlayEnabled, updatedAt, updatedBy, ...draft } = state;
    expect(
      saveRequestSchema.parse({ baseRevision: revision, state: draft }),
    ).toEqual({ baseRevision: 1, state: draft });
    const {
      petVisible: _petVisible,
      groupVisible: _groupVisible,
      compositeHudVisible: _compositeHudVisible,
      compositeChallengesVisible: _compositeChallengesVisible,
      ...legacyDraft
    } = draft;
    void [_petVisible, _groupVisible, _compositeHudVisible, _compositeChallengesVisible];
    expect(() => saveRequestSchema.parse({ baseRevision: revision, state: legacyDraft })).toThrow();
    expect(() =>
      saveRequestSchema.parse({
        baseRevision: 1,
        state: { ...draft, overlayEnabled },
      }),
    ).toThrow();
    expect(updatedAt).toBeTruthy();
    expect(updatedBy).toEqual(actor);
  });

  it("validates dedicated visibility and canonical 32-byte overlay token commands", () => {
    expect(visibilityRequestSchema.parse({ enabled: false })).toEqual({ enabled: false });
    const candidate = "A".repeat(43);
    expect(
      overlayTokenMutationRequestSchema.parse({
        requestId: "dc95708a-645a-4bc0-9ca3-7ffbd42e6662",
        expectedGeneration: 0,
      }),
    ).toEqual({
      requestId: "dc95708a-645a-4bc0-9ca3-7ffbd42e6662",
      expectedGeneration: 0,
    });
    expect(() =>
      overlayTokenMutationRequestSchema.parse({
        requestId: "not-a-uuid",
        expectedGeneration: 0,
      }),
    ).toThrow();
    expect(() =>
      overlayTokenMutationRequestSchema.parse({
        requestId: "dc95708a-645a-4bc0-9ca3-7ffbd42e6662",
        expectedGeneration: 0,
        candidateToken: candidate,
      }),
    ).toThrow();
    expect(overlayTokenStatusSchema.parse({
      exists: true,
      generation: 1,
      createdAt: "2026-08-29T12:00:00.000Z",
      lastUsedAt: null,
      connectedSockets: 0,
      token: candidate,
    }).token).toBe(candidate);
    expect(overlayTokenStatusSchema.parse({
      exists: true,
      generation: 1,
      createdAt: "2026-08-29T12:00:00.000Z",
      lastUsedAt: null,
      connectedSockets: 0,
      token: null,
    }).token).toBeNull();
    expect(overlayTokenResponseSchema.parse({
      requestId: "dc95708a-645a-4bc0-9ca3-7ffbd42e6662",
      generation: 1,
      fingerprint: "ABCDEF12",
      createdAt: "2026-08-29T12:00:00.000Z",
      token: candidate,
    }).token).toBe(candidate);
    expect(() => overlayTokenResponseSchema.parse({
      requestId: "dc95708a-645a-4bc0-9ca3-7ffbd42e6662",
      generation: 1,
      fingerprint: "ABCDEF12",
      createdAt: "2026-08-29T12:00:00.000Z",
    })).toThrow();
  });

  it("rejects bootstrap envelopes with non-editor roles or unknown fields", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const envelope = {
      capsule: {
        id: "irl-stream-hud",
        name: "Beispielkanal",
        timezone: "Europe/Berlin",
        limits: {
          maxGuests: 5,
          maxActiveEffects: 8,
          maxEditorSockets: 10,
          maxOverlaySockets: 10,
          maxMediaBytes: 8_388_608,
        },
        overlayToken: {
          exists: false,
          generation: 0,
          createdAt: null,
          lastUsedAt: null,
          connectedSockets: 0,
          token: null,
        },
      },
      capabilities: {
        phase: "v1a",
        enabledThemes: ["trail-wood"],
        petEditor: false,
        groupEditor: false,
        undo: false,
      },
      editor: { ...actor, role: "editor" },
      state,
      recentAudit: [],
      undoTargets: [],
      csrfToken: "csrf-token-with-enough-entropy",
      serverTime: "2026-08-29T12:00:00.000Z",
    };

    expect(bootstrapResponseSchema.parse(envelope)).toEqual(envelope);
    expect(
      bootstrapResponseSchema.parse({
        ...envelope,
        capsule: {
          ...envelope.capsule,
          limits: { ...envelope.capsule.limits, maxOverlaySockets: 2 },
        },
      }).capsule.limits.maxOverlaySockets,
    ).toBe(2);
    expect(() =>
      bootstrapResponseSchema.parse({
        ...envelope,
        editor: { ...envelope.editor, role: "admin" },
      }),
    ).toThrow();
    expect(() => bootstrapResponseSchema.parse({ ...envelope, debug: true })).toThrow();
  });

  it("uses a closed safe error union", () => {
    expect(createApiError("revision_conflict", "Neuere Revision", { currentRevision: 5 })).toEqual({
      error: {
        code: "revision_conflict",
        message: "Neuere Revision",
        currentRevision: 5,
      },
    });
  });

  it("discriminates public server WebSocket messages", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const auditEntry = {
      id: "audit-1",
      revision: 2,
      action: "save" as const,
      actor,
      summary: "Gespeichert",
      createdAt: "2026-08-29T12:01:00.000Z",
    };
    const undoTargets = [{
      revision: 1,
      createdAt: "2026-08-29T12:00:00.000Z",
      summary: "Startzustand",
    }];
    expect(serverMessageSchema.parse({ type: "snapshot", state })).toEqual({
      type: "snapshot",
      state,
    });
    expect(serverMessageSchema.parse({ type: "token_revoked" })).toEqual({
      type: "token_revoked",
    });
    expect(
      serverMessageSchema.parse({ type: "overlay_presence", connectedSockets: 10 }),
    ).toEqual({ type: "overlay_presence", connectedSockets: 10 });
    expect(serverMessageSchema.parse({ type: "history_changed", undoTargets })).toEqual({
      type: "history_changed",
      undoTargets,
    });
    expect(serverMessageSchema.parse({ type: "audit_appended", entry: auditEntry, undoTargets })).toEqual({
      type: "audit_appended",
      entry: auditEntry,
      undoTargets,
    });
    expect(() => serverMessageSchema.parse({
      type: "audit_appended",
      entry: auditEntry,
      undoTargets,
      debug: true,
    })).toThrow();
    expect(() =>
      // Aus der Konstante abgeleitet, damit der Fall beim Anheben der Grenze
      // nicht still zu einem gültigen Wert wird.
      serverMessageSchema.parse({
        type: "overlay_presence",
        connectedSockets: MAX_OVERLAY_SOCKETS + 1,
      }),
    ).toThrow();
    expect(() => serverMessageSchema.parse({ type: "secret_debug", value: 1 })).toThrow();
  });
});
