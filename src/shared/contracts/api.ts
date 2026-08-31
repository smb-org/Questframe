import { z } from "zod";

import {
  channelStateSaveDraftSchema,
  channelStateSchema,
  releaseCapabilitiesSchema,
  twitchUserIdSchema,
} from "./state";


export const API_ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "csrf_invalid",
  "role_ineligible",
  "not_found",
  "revision_conflict",
  "idempotency_mismatch",
  "token_changed",
  "token_invalid",
  "validation_failed",
  "challenge_timer_not_configured",
  "global_timer_not_configured",
  "payload_too_large",
  "media_quota_exceeded",
  "socket_limit",
  "rate_limited",
  "upstream_unavailable",
  "misconfigured",
  "internal_error",
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: z.string().min(1).max(160),
    fieldErrors: z.record(z.string(), z.string().min(1).max(160)).optional(),
    currentRevision: z.number().int().min(1).optional(),
    currentState: channelStateSchema.optional(),
    currentSnapshot: z.unknown().optional(),
  }),
});

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;

type ApiErrorDetails = {
  fieldErrors?: Record<string, string>;
  currentRevision?: number;
  currentState?: z.infer<typeof channelStateSchema>;
  currentSnapshot?: unknown;
};

export const createApiError = (
  code: ApiErrorCode,
  message: string,
  details: ApiErrorDetails = {},
): ApiError => apiErrorSchema.parse({ error: { code, message, ...details } });

export const MAX_OVERLAY_SOCKETS = 10 as const;
export const MAX_CHALLENGE_SOCKETS = 2 as const;
export const MAX_DOCK_SOCKETS = 2 as const;

export const limitsSchema = z.strictObject({
  maxGuests: z.literal(5),
  maxActiveEffects: z.literal(8),
  maxEditorSockets: z.literal(10),
  // Ein bereits laufender DO-Isolate kann während eines Deployments kurz noch
  // den bisherigen Wert liefern. Neue Server erzeugen ausschließlich 10.
  maxOverlaySockets: z.union([z.literal(2), z.literal(MAX_OVERLAY_SOCKETS)]),
  maxChallengeSockets: z.literal(MAX_CHALLENGE_SOCKETS).optional(),
  maxDockSockets: z.literal(MAX_DOCK_SOCKETS).optional(),
  maxMediaBytes: z.literal(8_388_608),
});

export const editorSchema = z.strictObject({
  twitchUserId: twitchUserIdSchema,
  displayName: z.string().min(1).max(32),
  role: z.literal("editor"),
});

export const auditEntrySchema = z.strictObject({
  id: z.string().min(1).max(64),
  revision: z.number().int().min(1),
  action: z.enum([
    "save",
    "force_replace",
    "undo",
    "overlay_enable",
    "overlay_disable",
    "token_create",
    "token_rotate",
  ]),
  actor: z.strictObject({
    twitchUserId: twitchUserIdSchema,
    displayName: z.string().min(1).max(32),
  }),
  summary: z.string().min(1).max(160),
  createdAt: z.iso.datetime({ offset: true }),
});

export const undoTargetSchema = z.strictObject({
  revision: z.number().int().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  summary: z.string().min(1).max(160),
});

export const overlayTokenStatusSchema = z.strictObject({
  exists: z.boolean(),
  generation: z.number().int().min(0),
  createdAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
  lastUsedAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
  connectedSockets: z.number().int().min(0).max(MAX_OVERLAY_SOCKETS),
  token: z.union([z.string().regex(/^[A-Za-z0-9_-]{43}$/), z.null()]),
});

export const dockTokenStatusSchema = z.strictObject({
  exists: z.boolean(),
  generation: z.number().int().min(0),
  fingerprint: z.union([z.string().regex(/^[A-F0-9]{8}$/), z.null()]),
  createdAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
  lastUsedAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
  connectedSockets: z.number().int().min(0).max(MAX_DOCK_SOCKETS),
  token: z.union([z.string().regex(/^[A-Za-z0-9_-]{43}$/), z.null()]),
});

export const bootstrapResponseSchema = z.strictObject({
  capsule: z.strictObject({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(80),
    timezone: z.string().min(1).max(64),
    limits: limitsSchema,
    overlayToken: overlayTokenStatusSchema,
    // Alte Test-/Bootstrap-Fassungen dürfen bis zum nächsten vollständigen Login ohne
    // Dock-Token gelesen werden; echte Antworten enthalten den Status immer.
    dockToken: dockTokenStatusSchema.optional(),
    channel: z
      .strictObject({
        id: twitchUserIdSchema,
        login: z.string().regex(/^[a-z0-9_]{1,25}$/),
        displayName: z.string().min(1).max(32),
      })
      .nullish(),
  }),
  capabilities: releaseCapabilitiesSchema,
  editor: editorSchema,
  state: channelStateSchema,
  recentAudit: z.array(auditEntrySchema).max(50),
  undoTargets: z.array(undoTargetSchema).max(20),
  csrfToken: z.string().min(16).max(128),
  serverTime: z.iso.datetime({ offset: true }),
});

export const saveRequestSchema = z.strictObject({
  baseRevision: z.number().int().min(1),
  replaceRevision: z.number().int().min(1).optional(),
  state: channelStateSaveDraftSchema,
});

export const saveResponseSchema = z.strictObject({
  state: channelStateSchema,
  auditEntry: auditEntrySchema,
  undoTargets: z.array(undoTargetSchema).max(20),
  serverTime: z.iso.datetime({ offset: true }),
});

export const undoRequestSchema = z.strictObject({
  baseRevision: z.number().int().min(1),
  targetRevision: z.number().int().min(1),
});

export const visibilityRequestSchema = z.strictObject({
  enabled: z.boolean(),
});

export const visibilityResponseSchema = z.strictObject({
  state: channelStateSchema,
  auditEntry: z.union([auditEntrySchema, z.null()]),
  undoTargets: z.array(undoTargetSchema).max(20),
  serverTime: z.iso.datetime({ offset: true }),
});

export const overlayTokenMutationRequestSchema = z.strictObject({
  requestId: z.uuid(),
  expectedGeneration: z.number().int().min(0),
});

export const overlayTokenResponseSchema = z.strictObject({
  requestId: z.uuid(),
  generation: z.number().int().min(1),
  fingerprint: z.string().regex(/^[A-F0-9]{8}$/),
  createdAt: z.iso.datetime({ offset: true }),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const dockTokenResponseSchema = z.strictObject({
  requestId: z.uuid(),
  generation: z.number().int().min(1),
  fingerprint: z.string().regex(/^[A-F0-9]{8}$/),
  createdAt: z.iso.datetime({ offset: true }),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const renewMediaLeasesRequestSchema = z.strictObject({
  contentHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(32),
});

export const renewMediaLeasesResponseSchema = z.strictObject({
  leases: z.array(
    z.strictObject({
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      leaseExpiresAt: z.iso.datetime({ offset: true }),
    }),
  ),
});

export const uploadResponseSchema = z.strictObject({
  portrait: z.strictObject({
    kind: z.literal("uploaded"),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  width: z.number().int().min(32).max(512),
  height: z.number().int().min(32).max(512),
  byteLength: z.number().int().min(1).max(262_144),
  leaseExpiresAt: z.iso.datetime({ offset: true }),
});

export const twitchLookupResponseSchema = z.strictObject({
  user: z.strictObject({
    id: twitchUserIdSchema,
    login: z.string().regex(/^[a-z0-9_]{1,25}$/),
    displayName: z.string().min(1).max(32),
    profileImageUrl: z.url().max(2_048),
  }),
});

export const healthResponseSchema = z.strictObject({
  status: z.enum(["ok", "misconfigured"]),
  schemaVersion: z.literal(1),
  missingBindings: z.array(z.string().min(1).max(64)),
});

export const revalidateResponseSchema = z.strictObject({
  editor: editorSchema,
  sessionExpiresAt: z.iso.datetime({ offset: true }),
  roleCheckedAt: z.iso.datetime({ offset: true }),
  csrfToken: z.string().min(16).max(128),
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("snapshot"), state: channelStateSchema }),
  z.strictObject({ type: z.literal("state_committed"), state: channelStateSchema }),
  z.strictObject({ type: z.literal("token_revoked") }),
  z.strictObject({
    type: z.literal("history_changed"),
    undoTargets: z.array(undoTargetSchema).max(20),
  }),
  z.strictObject({
    type: z.literal("audit_appended"),
    entry: auditEntrySchema,
    undoTargets: z.array(undoTargetSchema).max(20),
  }),
  z.strictObject({
    type: z.literal("time_sync"),
    clientTimestamp: z.number(),
    serverTime: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    type: z.literal("overlay_presence"),
    connectedSockets: z.number().int().min(0).max(MAX_OVERLAY_SOCKETS),
  }),
]);

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("time_sync_request"),
    clientTimestamp: z.number(),
  }),
]);

export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
export type SaveRequest = z.infer<typeof saveRequestSchema>;
export type SaveResponse = z.infer<typeof saveResponseSchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type UndoTarget = z.infer<typeof undoTargetSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type OverlayTokenResponse = z.infer<typeof overlayTokenResponseSchema>;
export type DockTokenResponse = z.infer<typeof dockTokenResponseSchema>;
