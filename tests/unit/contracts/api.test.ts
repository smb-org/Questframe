import { describe, expect, it } from "vitest";

import {
  bootstrapResponseSchema,
  createApiError,
  overlayTokenMutationRequestSchema,
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
        candidateToken: candidate,
      }),
    ).toMatchObject({ candidateToken: candidate });
    expect(() =>
      overlayTokenMutationRequestSchema.parse({
        requestId: "not-a-uuid",
        expectedGeneration: 0,
        candidateToken: "too-short",
      }),
    ).toThrow();
  });

  it("rejects bootstrap envelopes with non-editor roles or unknown fields", () => {
    const state = createDefaultState(actor, "2026-08-29T12:00:00.000Z");
    const envelope = {
      capsule: {
        id: "irl-stream-hud",
        name: "IRL Stream HUD",
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
    expect(() =>
      serverMessageSchema.parse({ type: "overlay_presence", connectedSockets: 11 }),
    ).toThrow();
    expect(() => serverMessageSchema.parse({ type: "secret_debug", value: 1 })).toThrow();
  });
});
