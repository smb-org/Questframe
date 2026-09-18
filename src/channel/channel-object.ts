import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import {
  auditEntrySchema,
  bootstrapResponseSchema,
  clientMessageSchema,
  dockTokenResponseSchema,
  flushDisplaySocketsResponseSchema,
  MAX_COMPOSITE_SOCKETS,
  MAX_CHALLENGE_SOCKETS,
  MAX_DOCK_SOCKETS,
  SOCKET_STALE_AFTER_MS,
  MAX_EDITOR_SOCKETS,
  MAX_OVERLAY_SOCKETS,
  overlayTokenMutationRequestSchema,
  overlayTokenResponseSchema,
  renewMediaLeasesRequestSchema,
  renewMediaLeasesResponseSchema,
  saveRequestSchema,
  saveResponseSchema,
  twitchLookupResponseSchema,
  undoRequestSchema,
  uploadResponseSchema,
  visibilityRequestSchema,
  visibilityResponseSchema,
  type AuditEntry,
  type UndoTarget,
} from "../shared/contracts/api";
import { DOCK_SOCKET_PROTOCOL, OVERLAY_SOCKET_PROTOCOL } from "../shared/contracts/protocol";
import {
  channelStateDraftSchema,
  channelStateSchema,
  createDefaultState,
  getReleaseCapabilities,
  normalizeStateForRead,
  stateByteLength,
  validateDraftForRelease,
  type ChannelState,
  type ChannelStateDraft,
} from "../shared/contracts/state";
import { EFFECT_CATALOG, getEffectDefinition, validateEffectExpiries } from "../shared/domain/effects";
import { inspectWebP } from "../shared/media/webp";
import type { AppEnv } from "../worker/env";
import { errorResponse, jsonResponse, readJson, RequestError } from "../worker/http";
import { hmacHex, randomToken, sha256Hex, timingSafeEqual } from "./crypto";
import { decryptOverlayToken, encryptOverlayToken, tokenEnvelopeSchema } from "./auth/crypto";
import { runMigrations } from "./migrations";
import {
  challengeRepository as createChallengeRepository,
  challengeService as createChallengeService,
} from "../modules/win-challenges/adapters/http-facade";
import {
  ChallengeRepositoryError,
  RevisionConflictError,
  type DockTokenRecord,
} from "../modules/win-challenges/repository/challenge-repository";
import { MODULE_REGISTRY, type ModuleContext } from "../modules/registry";

type StateRow = {
  revision: number;
  overlay_enabled: number;
  state_json: string;
  updated_at: string;
  updated_by_id: string;
  updated_by_name: string;
};

type SessionRow = {
  session_hash: string;
  twitch_user_id: string;
  display_name: string;
  generation: number;
  role_checked_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
};

type OverlayTokenRow = {
  token_hash: string;
  token_envelope: string | null;
  fingerprint: string;
  generation: number;
  request_id: string;
  creating_session_hash: string;
  created_at: string;
  last_used_at: string | null;
};

type SocketAttachment =
  | {
      version: 1;
      kind: "editor";
      connectionId: string;
      sessionRecordId: string;
      sessionGeneration: number;
      tabId: string;
      connectedAt: string;
    }
  | {
      version: 1;
      kind: "overlay";
      connectionId: string;
      tokenGeneration: number;
      connectedAt: string;
    }
  | {
      version: 1;
      kind: "composite";
      connectionId: string;
      tokenGeneration: number;
      connectedAt: string;
    }
  | {
      version: 1;
      kind: "challenge";
      connectionId: string;
      tokenGeneration: number;
      connectedAt: string;
    }
  | {
      version: 1;
      kind: "dock";
      connectionId: string;
      tokenGeneration: number;
      connectedAt: string;
    };

const limits = {
  maxGuests: 5,
  maxActiveEffects: 8,
  maxEditorSockets: MAX_EDITOR_SOCKETS,
  maxOverlaySockets: MAX_OVERLAY_SOCKETS,
  maxCompositeSockets: MAX_COMPOSITE_SOCKETS,
  maxChallengeSockets: MAX_CHALLENGE_SOCKETS,
  maxDockSockets: MAX_DOCK_SOCKETS,
  maxMediaBytes: 8_388_608,
} as const;
const maxMediaBlobs = 32;

const nowIso = (): string => new Date().toISOString();

const actorFromSession = (session: SessionRow) => ({
  twitchUserId: session.twitch_user_id,
  displayName: session.display_name,
});

const draftFromState = (state: ChannelState): ChannelStateDraft => {
  const {
    revision: _revision,
    overlayEnabled: _overlayEnabled,
    updatedAt: _updatedAt,
    updatedBy: _updatedBy,
    ...draft
  } = state;
  void [_revision, _overlayEnabled, _updatedAt, _updatedBy];
  return channelStateDraftSchema.parse(draft);
};

const filterExpiredEffectsFromDraft = (draft: ChannelStateDraft): ChannelStateDraft => {
  const now = Date.now();
  const effects = draft.effects
    .filter((effect) => effect.expiresAt === null || Date.parse(effect.expiresAt) > now)
    .map((effect, order) => ({ ...effect, order }));
  const featuredEffectId = effects.some((effect) => effect.id === draft.featuredEffectId)
    ? draft.featuredEffectId
    : null;
  return channelStateDraftSchema.parse({ ...draft, effects, featuredEffectId });
};

const summarizeChange = (before: ChannelState, after: ChannelState): string => {
  const changes: string[] = [];
  if (before.player.hpPercent !== after.player.hpPercent) {
    changes.push(`HP: ${String(after.player.hpPercent)}%`);
  }
  if (before.player.resource.percent !== after.player.resource.percent) {
    changes.push(`${after.player.resource.name}: ${String(after.player.resource.percent)}%`);
  }
  if (
    before.placement.x !== after.placement.x ||
    before.placement.y !== after.placement.y ||
    before.placement.scale !== after.placement.scale
  ) {
    changes.push(`Position: ${String(after.placement.x)}/${String(after.placement.y)} bei ${String(Math.round(after.placement.scale * 100))}%`);
  }
  if (before.effects.length !== after.effects.length) {
    changes.push(`Effekte: ${String(after.effects.length)}`);
  }
  if (before.player.name !== after.player.name) changes.push(`Name: ${after.player.name}`);
  if (before.themeId !== after.themeId) changes.push(`Theme: ${after.themeId}`);
  if (before.compositeHudVisible !== after.compositeHudVisible) {
    changes.push(`HUD im Sammel-Overlay: ${after.compositeHudVisible ? "An" : "Aus"}`);
  }
  if (before.compositeChallengesVisible !== after.compositeChallengesVisible) {
    changes.push(`Challenges im Sammel-Overlay: ${after.compositeChallengesVisible ? "An" : "Aus"}`);
  }
  return changes.length > 0 ? changes.join(" · ") : "HUD-Einstellungen aktualisiert";
};

const mapZodIssues = (error: z.ZodError): Record<string, string> =>
  Object.fromEntries(
    error.issues.map((issue) => [
      issue.path
        .map((part, index) =>
          typeof part === "number"
            ? `[${String(part)}]`
            : `${index > 0 ? "." : ""}${String(part)}`,
        )
        .join(""),
      issue.message,
    ]),
  );

export class ChannelObject extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    runMigrations(ctx.storage.sql, env.CF_VERSION_METADATA.id);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/internal/session/dev") {
        return await this.createDevSession(request);
      }
      if (request.method === "POST" && url.pathname === "/internal/oauth/nonce") {
        return await this.createOAuthNonce(request);
      }
      if (request.method === "POST" && url.pathname === "/internal/oauth/consume") {
        return await this.consumeOAuthNonce(request);
      }
      if (request.method === "POST" && url.pathname === "/internal/session/oauth") {
        return await this.createOAuthSession(request);
      }
      if (request.method === "GET" && url.pathname === "/internal/auth/material") {
        return this.getAuthMaterial(request);
      }
      if (request.method === "POST" && url.pathname === "/internal/auth/confirm") {
        return await this.confirmRevalidation(request);
      }
      if (request.method === "POST" && url.pathname === "/internal/twitch/cache") {
        return await this.cacheTwitchUser(request);
      }
      if (request.method === "POST" && url.pathname === "/internal/session/logout") {
        return this.logout(request);
      }
      if (request.method === "GET" && url.pathname === "/editor/bootstrap") {
        return await this.bootstrap(request);
      }
      const moduleResponse = await this.dispatchModuleRequest(request, url.pathname);
      if (moduleResponse !== null) return moduleResponse;
      if (request.method === "POST" && url.pathname === "/challenges/dock-token") {
        return await this.mutateDockToken(request, false);
      }
      if (request.method === "POST" && url.pathname === "/challenges/dock-token/rotate") {
        return await this.mutateDockToken(request, true);
      }
      if (request.method === "PUT" && url.pathname === "/state") {
        return await this.save(request);
      }
      if (request.method === "POST" && url.pathname === "/overlay-visibility") {
        return await this.setVisibility(request);
      }
      if (request.method === "POST" && url.pathname === "/state/undo") {
        return await this.undo(request);
      }
      if (request.method === "POST" && url.pathname === "/overlay-token") {
        return await this.mutateOverlayToken(request, false);
      }
      if (request.method === "POST" && url.pathname === "/overlay-token/rotate") {
        return await this.mutateOverlayToken(request, true);
      }
      if (request.method === "POST" && url.pathname === "/sockets/flush") {
        return await this.flushDisplaySockets(request);
      }
      if (request.method === "POST" && url.pathname === "/media") {
        return await this.uploadMedia(request);
      }
      if (request.method === "POST" && url.pathname === "/media/leases/renew") {
        return await this.renewMediaLeases(request);
      }
      if (request.method === "GET" && url.pathname.startsWith("/media/")) {
        return await this.getMedia(request, url.pathname.slice("/media/".length));
      }
      if (request.method === "GET" && url.pathname === "/ws/editor") {
        return this.connectEditor(request);
      }
      if (request.method === "GET" && url.pathname === "/ws/overlay") {
        return await this.connectOverlay(request);
      }
      if (request.method === "GET" && url.pathname === "/ws/composite") {
        return await this.connectComposite(request);
      }
      if (request.method === "GET" && url.pathname === "/ws/challenge") {
        return await this.connectChallenge(request);
      }
      if (request.method === "GET" && url.pathname === "/ws/dock") {
        return await this.connectDock(request);
      }
      return errorResponse(404, "not_found", "Route nicht gefunden.");
    } catch (error) {
      if (error instanceof RequestError) {
        return errorResponse(error.status, error.code, error.message, error.details);
      }
      if (error instanceof z.ZodError) {
        return errorResponse(422, "validation_failed", "Bitte Eingaben prüfen.", {
          fieldErrors: mapZodIssues(error),
        });
      }
      if (error instanceof ChallengeRepositoryError) {
        const status: Record<ChallengeRepositoryError["code"], number> = {
          idempotency_mismatch: 409,
          not_found: 404,
          revision_conflict: 409,
          validation_failed: 422,
          challenge_timer_not_configured: 422,
          global_timer_not_configured: 422,
        };
        const details = error instanceof RevisionConflictError
          ? { currentSnapshot: error.snapshot }
          : {};
        return errorResponse(status[error.code], error.code, error.message, details);
      }
      console.error("channel_request_failed", {
        path: url.pathname,
        error: error instanceof Error ? error.name : "unknown",
      });
      return errorResponse(500, "internal_error", "Interner Fehler.");
    }
  }

  private async dispatchModuleRequest(request: Request, pathname: string): Promise<Response | null> {
    for (const module of MODULE_REGISTRY) {
      if (!module.routePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) continue;
      if (module.handle === undefined) continue;
      const response = await module.handle(request, this.createModuleContext());
      if (response !== null) return response;
    }
    return null;
  }

  private createModuleContext(): ModuleContext {
    return {
      sql: this.ctx.storage.sql,
      transactionSync: this.ctx.storage.transactionSync.bind(this.ctx.storage),
      requireSession: (request) => {
        this.requireSession(request);
      },
      requireSessionAndCsrf: async (request) => {
        const session = this.requireSession(request);
        await this.requireCsrf(request, session);
      },
      requireDockToken: async (request) => {
        await this.requireDockToken(request);
      },
      broadcast: (tags, payload) => {
        this.broadcast(tags, payload);
      },
      revokeTokenSockets: (tag) => {
        this.revokeTokenSockets(tag);
      },
    };
  }

  private async createDevSession(request: Request): Promise<Response> {
    if (this.env.APP_ENV !== "local") {
      throw new RequestError(404, "not_found", "Route nicht gefunden.");
    }
    const input = z
      .strictObject({
        sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
        twitchUserId: z.string().regex(/^\d+$/),
        displayName: z.string().min(1).max(32),
      })
      .parse(await readJson(request, 1_024));
    const now = new Date();
    const idle = new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString();
    const absolute = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO editor_sessions(
        session_hash, twitch_user_id, display_name, generation, role_checked_at,
        idle_expires_at, absolute_expires_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(session_hash) DO UPDATE SET
        display_name = excluded.display_name,
        role_checked_at = excluded.role_checked_at,
        idle_expires_at = excluded.idle_expires_at`,
      input.sessionHash,
      input.twitchUserId,
      input.displayName,
      now.toISOString(),
      idle,
      absolute,
    );
    const session = this.getSessionByHash(input.sessionHash, false);
    if (session === null) throw new Error("Session creation failed");
    this.ensureState(session);
    return jsonResponse({ ok: true });
  }

  private async createOAuthNonce(request: Request): Promise<Response> {
    const input = z
      .strictObject({
        nonceHash: z.string().regex(/^[a-f0-9]{64}$/),
        bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
        pkceVerifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        expiresAt: z.iso.datetime({ offset: true }),
      })
      .parse(await readJson(request, 2_048));
    this.ctx.storage.sql.exec(
      "DELETE FROM oauth_nonces WHERE expires_at <= ? OR consumed_at IS NOT NULL",
      nowIso(),
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO oauth_nonces(
        nonce_hash, binding_hash, pkce_verifier, expires_at, consumed_at
      ) VALUES (?, ?, ?, ?, NULL)`,
      input.nonceHash,
      input.bindingHash,
      input.pkceVerifier,
      input.expiresAt,
    );
    return jsonResponse({ ok: true });
  }

  private async consumeOAuthNonce(request: Request): Promise<Response> {
    const input = z
      .strictObject({
        nonceHash: z.string().regex(/^[a-f0-9]{64}$/),
        bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(await readJson(request, 1_024));
    const verifier = this.ctx.storage.transactionSync((): string | null => {
      const row = this.ctx.storage.sql
        .exec<{
          binding_hash: string;
          pkce_verifier: string;
          expires_at: string;
          consumed_at: string | null;
        }>("SELECT * FROM oauth_nonces WHERE nonce_hash = ?", input.nonceHash)
        .toArray()[0];
      if (
        row !== undefined &&
        row.consumed_at === null &&
        Date.parse(row.expires_at) > Date.now() &&
        timingSafeEqual(row.binding_hash, input.bindingHash)
      ) {
        this.ctx.storage.sql.exec(
          "UPDATE oauth_nonces SET consumed_at = ? WHERE nonce_hash = ? AND consumed_at IS NULL",
          nowIso(),
          input.nonceHash,
        );
        return row.pkce_verifier;
      }
      return null;
    });
    if (verifier === null) {
      throw new RequestError(400, "bad_request", "Twitch-Anmeldung ist abgelaufen oder wurde bereits benutzt.");
    }
    return jsonResponse({ pkceVerifier: verifier });
  }

  private async createOAuthSession(request: Request): Promise<Response> {
    const input = z
      .strictObject({
        sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
        twitchUserId: z.string().regex(/^\d+$/),
        displayName: z.string().min(1).max(32),
        accessTokenEnvelope: z.string().min(1).max(8_192),
        refreshTokenEnvelope: z.string().min(1).max(8_192),
        tokenExpiresAt: z.iso.datetime({ offset: true }),
      })
      .parse(await readJson(request, 24_576));
    const now = new Date();
    const idle = new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString();
    const absolute = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO editor_sessions(
        session_hash, twitch_user_id, display_name, generation, role_checked_at,
        idle_expires_at, absolute_expires_at, access_token_envelope,
        refresh_token_envelope, token_expires_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      input.sessionHash,
      input.twitchUserId,
      input.displayName,
      now.toISOString(),
      idle,
      absolute,
      input.accessTokenEnvelope,
      input.refreshTokenEnvelope,
      input.tokenExpiresAt,
    );
    const session = this.getSessionByHash(input.sessionHash, false);
    if (session === null) throw new Error("OAuth session creation failed");
    this.ensureState(session);
    return jsonResponse({ ok: true, generation: 1 });
  }

  private getAuthMaterial(request: Request): Response {
    const hash = request.headers.get("x-session-hash");
    if (hash === null) throw new RequestError(401, "unauthorized", "Sitzung fehlt.");
    const session = this.getSessionByHash(hash, false);
    if (session === null) throw new RequestError(401, "unauthorized", "Sitzung abgelaufen.");
    const row = this.ctx.storage.sql
      .exec<{
        access_token_envelope: string | null;
        refresh_token_envelope: string | null;
        token_expires_at: string | null;
      }>(
        "SELECT access_token_envelope, refresh_token_envelope, token_expires_at FROM editor_sessions WHERE session_hash = ?",
        hash,
      )
      .toArray()[0];
    if (
      row?.access_token_envelope === null ||
      row?.access_token_envelope === undefined ||
      row.refresh_token_envelope === null ||
      row.token_expires_at === null
    ) {
      throw new RequestError(401, "unauthorized", "Twitch-Sitzung muss neu angemeldet werden.");
    }
    return jsonResponse({
      sessionHash: session.session_hash,
      twitchUserId: session.twitch_user_id,
      displayName: session.display_name,
      generation: session.generation,
      accessTokenEnvelope: JSON.parse(row.access_token_envelope) as unknown,
      refreshTokenEnvelope: JSON.parse(row.refresh_token_envelope) as unknown,
      tokenExpiresAt: row.token_expires_at,
    });
  }

  private async confirmRevalidation(request: Request): Promise<Response> {
    const input = z
      .strictObject({
        sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
        generation: z.number().int().min(1),
        twitchUserId: z.string().regex(/^\d+$/),
        displayName: z.string().min(1).max(32),
        accessTokenEnvelope: z.string().min(1).max(8_192),
        refreshTokenEnvelope: z.string().min(1).max(8_192),
        tokenExpiresAt: z.iso.datetime({ offset: true }),
        tabId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
      })
      .parse(await readJson(request, 24_576));
    const checkedAt = nowIso();
    const current = this.getSessionByHash(input.sessionHash, false);
    if (
      current === null ||
      current.generation !== input.generation ||
      current.twitch_user_id !== input.twitchUserId
    ) {
      throw new RequestError(409, "revision_conflict", "Sitzung wurde während der Prüfung geändert.");
    }
    const idleExpiresAt = new Date(
      Math.min(Date.now() + 24 * 60 * 60 * 1_000, Date.parse(current.absolute_expires_at)),
    ).toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE editor_sessions SET
        display_name = ?, role_checked_at = ?, idle_expires_at = ?,
        access_token_envelope = ?, refresh_token_envelope = ?, token_expires_at = ?
      WHERE session_hash = ? AND generation = ?`,
      input.displayName,
      checkedAt,
      idleExpiresAt,
      input.accessTokenEnvelope,
      input.refreshTokenEnvelope,
      input.tokenExpiresAt,
      input.sessionHash,
      input.generation,
    );
    const csrfToken = await this.rotateCsrf(input.sessionHash, input.tabId);
    return jsonResponse({
      editor: {
        twitchUserId: input.twitchUserId,
        displayName: input.displayName,
        role: "editor",
      },
      sessionExpiresAt: idleExpiresAt,
      roleCheckedAt: checkedAt,
      csrfToken,
    });
  }

  private async cacheTwitchUser(request: Request): Promise<Response> {
    const input = twitchLookupResponseSchema.parse(await readJson(request, 8_192));
    this.ctx.storage.sql.exec(
      "DELETE FROM twitch_user_cache WHERE login = ? AND twitch_user_id <> ?",
      input.user.login,
      input.user.id,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO twitch_user_cache(
        twitch_user_id, login, display_name, portrait_url, fetched_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(twitch_user_id) DO UPDATE SET
        login = excluded.login,
        display_name = excluded.display_name,
        portrait_url = excluded.portrait_url,
        fetched_at = excluded.fetched_at`,
      input.user.id,
      input.user.login,
      input.user.displayName,
      input.user.profileImageUrl,
      nowIso(),
    );
    return jsonResponse(input);
  }

  private logout(request: Request): Response {
    const hash = request.headers.get("x-session-hash");
    if (hash !== null) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DELETE FROM csrf_tokens WHERE session_hash = ?", hash);
        this.ctx.storage.sql.exec("DELETE FROM editor_sessions WHERE session_hash = ?", hash);
      });
      for (const socket of this.ctx.getWebSockets("editor")) {
        const attachment = this.readAttachment(socket);
        if (attachment?.kind === "editor" && attachment.sessionRecordId === hash) {
          socket.close(4001, "session_revoked");
        }
      }
    }
    return jsonResponse({ ok: true });
  }

  private async bootstrap(request: Request): Promise<Response> {
    const session = this.requireSession(request);
    const tabId = this.requireTabId(request);
    const csrfToken = await this.rotateCsrf(session.session_hash, tabId);
    const state = normalizeStateForRead(this.ensureState(session));
    const overlayToken = this.getOverlayToken();
    const dockToken = this.getDockToken();
    const broadcasterProfile = this.getBroadcasterProfile();
    const response = bootstrapResponseSchema.parse({
      capsule: {
        id: this.env.CAPSULE_ID,
        name: this.env.CAPSULE_NAME,
        timezone: this.env.TIMEZONE,
        limits,
        channel: broadcasterProfile,
        overlayToken: {
          exists: overlayToken !== null,
          generation: overlayToken?.generation ?? 0,
          createdAt: overlayToken?.created_at ?? null,
          lastUsedAt: overlayToken?.last_used_at ?? null,
          connectedSockets: this.countPresenceSockets(),
          token: await this.readOverlayToken(overlayToken),
        },
        dockToken: {
          exists: dockToken !== null,
          generation: dockToken?.generation ?? 0,
          fingerprint: dockToken?.fingerprint ?? null,
          createdAt: dockToken?.createdAt ?? null,
          lastUsedAt: dockToken?.lastUsedAt ?? null,
          connectedSockets: Math.min(MAX_DOCK_SOCKETS, this.ctx.getWebSockets("dock").length),
          token: await this.readDockTokenValue(dockToken),
        },
      },
      capabilities: getReleaseCapabilities(this.env.RELEASE_STAGE),
      editor: { ...actorFromSession(session), role: "editor" },
      state,
      recentAudit: this.getAuditEntries(),
      undoTargets: this.getUndoTargets(),
      csrfToken,
      serverTime: nowIso(),
    });
    return jsonResponse(response);
  }

  private async save(request: Request): Promise<Response> {
    const session = this.requireSession(request);
    await this.requireCsrf(request, session);
    const input = saveRequestSchema.parse(await readJson(request, 131_072));
    const current = normalizeStateForRead(this.getRequiredState());
    const forceReplace = input.replaceRevision !== undefined;
    const currentMatches = input.baseRevision === current.revision;
    const guardedReplaceMatches =
      forceReplace && input.replaceRevision === current.revision && input.baseRevision < current.revision;
    if ((!forceReplace && !currentMatches) || (forceReplace && !guardedReplaceMatches)) {
      throw new RequestError(409, "revision_conflict", "OBS wurde inzwischen geändert.", {
        currentRevision: current.revision,
        currentState: current,
      });
    }
    let draft: ChannelStateDraft;
    try {
      draft = validateDraftForRelease(
        this.canonicalizeTwitchGroup(filterExpiredEffectsFromDraft(input.state)),
        this.env.RELEASE_STAGE,
      );
      validateEffectExpiries(draft.effects, current.effects);
    } catch (error) {
      if (error instanceof RequestError || error instanceof z.ZodError) throw error;
      if (error instanceof Error) {
        throw new RequestError(422, "validation_failed", error.message);
      }
      throw error;
    }
    this.validateCatalog(draft);
    this.validateMediaReferences(draft, current, session);
    if (stateByteLength(draft) > 65_536) {
      throw new RequestError(413, "payload_too_large", "Der HUD-Zustand überschreitet 64 KiB.");
    }
    const createdAt = nowIso();
    const next = channelStateSchema.parse({
      ...draft,
      revision: current.revision + 1,
      overlayEnabled: current.overlayEnabled,
      updatedAt: createdAt,
      updatedBy: actorFromSession(session),
    });
    const action = forceReplace ? "force_replace" : "save";
    const summary = summarizeChange(current, next);
    const audit = this.makeAudit(next.revision, action, session, summary, createdAt);
    this.ctx.storage.transactionSync(() => {
      this.insertHistory(current, summary);
      this.writeState(next);
      this.insertAudit(audit);
      this.pruneHistoryAndAudit();
    });
    this.broadcastState(next);
    const undoTargets = this.getUndoTargets();
    this.broadcastAudit(audit, undoTargets);
    const response = saveResponseSchema.parse({
      state: next,
      auditEntry: audit,
      undoTargets,
      serverTime: createdAt,
    });
    return jsonResponse(response);
  }

  private async setVisibility(request: Request): Promise<Response> {
    const session = this.requireSession(request);
    await this.requireCsrf(request, session);
    const input = visibilityRequestSchema.parse(await readJson(request, 1_024));
    const current = normalizeStateForRead(this.getRequiredState());
    if (current.overlayEnabled === input.enabled) {
      return jsonResponse(
        visibilityResponseSchema.parse({
          state: current,
          auditEntry: null,
          undoTargets: this.getUndoTargets(),
          serverTime: nowIso(),
        }),
      );
    }
    const createdAt = nowIso();
    const next = channelStateSchema.parse({
      ...current,
      revision: current.revision + 1,
      overlayEnabled: input.enabled,
      updatedAt: createdAt,
      updatedBy: actorFromSession(session),
    });
    const action = input.enabled ? "overlay_enable" : "overlay_disable";
    const summary = input.enabled ? "Overlay aktiviert" : "Overlay deaktiviert";
    const audit = this.makeAudit(next.revision, action, session, summary, createdAt);
    this.ctx.storage.transactionSync(() => {
      this.insertHistory(current, summary);
      this.writeState(next);
      this.insertAudit(audit);
      this.pruneHistoryAndAudit();
    });
    this.broadcastState(next);
    const undoTargets = this.getUndoTargets();
    this.broadcastAudit(audit, undoTargets);
    return jsonResponse(
      visibilityResponseSchema.parse({
        state: next,
        auditEntry: audit,
        undoTargets,
        serverTime: createdAt,
      }),
    );
  }

  private async undo(request: Request): Promise<Response> {
    if (!getReleaseCapabilities(this.env.RELEASE_STAGE).undo) {
      throw new RequestError(403, "forbidden", "Undo ist in V1a noch nicht freigeschaltet.");
    }
    const session = this.requireSession(request);
    await this.requireCsrf(request, session);
    const input = undoRequestSchema.parse(await readJson(request, 1_024));
    const current = normalizeStateForRead(this.getRequiredState());
    if (input.baseRevision !== current.revision) {
      throw new RequestError(409, "revision_conflict", "OBS wurde inzwischen geändert.", {
        currentRevision: current.revision,
        currentState: current,
      });
    }
    const history = this.ctx.storage.sql
      .exec<{ snapshot_json: string }>(
        "SELECT snapshot_json FROM state_history WHERE revision = ?",
        input.targetRevision,
      )
      .toArray()[0];
    if (history === undefined) {
      throw new RequestError(404, "not_found", "Diese Revision ist nicht mehr verfügbar.");
    }
    const rawTarget = JSON.parse(history.snapshot_json) as Record<string, unknown>;
    const target = normalizeStateForRead(
      channelStateSchema.parse({
        ...rawTarget,
        compositeHudVisible: Object.hasOwn(rawTarget, "compositeHudVisible")
          ? rawTarget.compositeHudVisible
          : current.compositeHudVisible,
        compositeChallengesVisible: Object.hasOwn(rawTarget, "compositeChallengesVisible")
          ? rawTarget.compositeChallengesVisible
          : current.compositeChallengesVisible,
      }),
    );
    const createdAt = nowIso();
    const next = channelStateSchema.parse({
      ...target,
      revision: current.revision + 1,
      overlayEnabled: current.overlayEnabled,
      updatedAt: createdAt,
      updatedBy: actorFromSession(session),
    });
    const carriedForward = [
      Object.hasOwn(rawTarget, "compositeHudVisible") ? null : "HUD im Sammel-Overlay",
      Object.hasOwn(rawTarget, "compositeChallengesVisible") ? null : "Challenges im Sammel-Overlay",
    ].filter((label): label is string => label !== null);
    const summary = carriedForward.length === 0
      ? `Revision ${String(input.targetRevision)} wiederhergestellt`
      : `Revision ${String(input.targetRevision)} wiederhergestellt (${carriedForward.join(" und ")} beibehalten)`;
    const audit = this.makeAudit(next.revision, "undo", session, summary, createdAt);
    this.ctx.storage.transactionSync(() => {
      this.insertHistory(current, summary);
      this.writeState(next);
      this.insertAudit(audit);
      this.pruneHistoryAndAudit();
    });
    this.broadcastState(next);
    const undoTargets = this.getUndoTargets();
    this.broadcastAudit(audit, undoTargets);
    return jsonResponse(
      saveResponseSchema.parse({
        state: next,
        auditEntry: audit,
        undoTargets,
        serverTime: createdAt,
      }),
    );
  }

  private async mutateOverlayToken(request: Request, rotate: boolean): Promise<Response> {
    const session = this.requireSession(request);
    await this.requireCsrf(request, session);
    const input = overlayTokenMutationRequestSchema.parse(await readJson(request, 2_048));
    const pepper = this.getOverlayTokenPepper();
    const current = this.getOverlayToken();
    const currentGeneration = current?.generation ?? 0;
    if (
      current !== null &&
      current.generation === input.expectedGeneration + 1 &&
      current.request_id === input.requestId
    ) {
      if (
        current.creating_session_hash !== session.session_hash
      ) {
        throw new RequestError(409, "idempotency_mismatch", "Token-Anfrage wurde anders wiederholt.");
      }
      const token = await this.readOverlayToken(current);
      if (token === null) {
        throw new RequestError(409, "idempotency_mismatch", "Token-Anfrage kann nicht wiederhergestellt werden.");
      }
      if (rotate) {
        this.revokeTokenSockets("overlay", input.expectedGeneration);
        this.revokeTokenSockets("composite", input.expectedGeneration);
        this.revokeTokenSockets("challenge", input.expectedGeneration);
      }
      return jsonResponse(
        overlayTokenResponseSchema.parse({
          requestId: current.request_id,
          generation: current.generation,
          fingerprint: current.fingerprint,
          createdAt: current.created_at,
          token,
        }),
      );
    }
    if (currentGeneration !== input.expectedGeneration || (rotate ? current === null : current !== null)) {
      throw new RequestError(409, "token_changed", "Der OBS-Tokenstatus hat sich geändert.");
    }
    const createdAt = nowIso();
    const generation = currentGeneration + 1;
    const token = randomToken(32);
    const tokenHash = await hmacHex(pepper, token);
    const tokenEnvelope = await encryptOverlayToken(token, pepper, this.env.CAPSULE_ID);
    const currentAfterCrypto = this.getOverlayToken();
    if (
      (currentAfterCrypto?.generation ?? 0) !== currentGeneration ||
      (rotate ? currentAfterCrypto === null : currentAfterCrypto !== null)
    ) {
      throw new RequestError(409, "token_changed", "Der OBS-Tokenstatus hat sich geändert.");
    }
    const fingerprint = tokenHash.slice(0, 8).toUpperCase();
    this.ctx.storage.sql.exec(
      `INSERT INTO overlay_tokens(
        singleton, token_hash, token_envelope, fingerprint, generation, request_id,
        creating_session_hash, created_at, last_used_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(singleton) DO UPDATE SET
        token_hash = excluded.token_hash,
        token_envelope = excluded.token_envelope,
        fingerprint = excluded.fingerprint,
        generation = excluded.generation,
        request_id = excluded.request_id,
        creating_session_hash = excluded.creating_session_hash,
        created_at = excluded.created_at,
        last_used_at = NULL`,
      tokenHash,
      JSON.stringify(tokenEnvelope),
      fingerprint,
      generation,
      input.requestId,
      session.session_hash,
      createdAt,
    );
    if (rotate) {
      this.revokeTokenSockets("overlay", currentGeneration);
      this.revokeTokenSockets("composite", currentGeneration);
      this.revokeTokenSockets("challenge", currentGeneration);
    }
    return jsonResponse(
      overlayTokenResponseSchema.parse({
        requestId: input.requestId,
        generation,
        fingerprint,
        createdAt,
        token,
      }),
    );
  }

  /**
   * Trennt alle Anzeige-Sockets, aber bewusst keine Editor-Sockets, damit das
   * Admin-Fenster, das die Notbremse auslöst, verbunden bleibt. Die Anzeige-
   * Clients verbinden sich nach dem kurzen Blink selbst wieder.
   */
  private async flushDisplaySockets(request: Request): Promise<Response> {
    const session = this.requireSession(request);
    await this.requireCsrf(request, session);
    const displayTags = ["overlay", "composite", "challenge", "dock"] as const;
    let closed = 0;
    for (const tag of displayTags) {
      for (const socket of this.ctx.getWebSockets(tag)) {
        const wasOpen = socket.readyState === WebSocket.OPEN;
        try {
          socket.close(4007, "sockets_flushed");
          if (wasOpen) closed += 1;
        } catch {
          // Ein bereits geschlossener Socket darf die übrigen nicht blockieren.
        }
      }
    }
    return jsonResponse(flushDisplaySocketsResponseSchema.parse({ closed }));
  }

  private async readOverlayToken(row: OverlayTokenRow | null): Promise<string | null> {
    return this.readTokenEnvelope(row?.token_envelope ?? null);
  }

  private async readDockTokenValue(row: DockTokenRecord | null): Promise<string | null> {
    return this.readTokenEnvelope(row?.tokenEnvelope ?? null);
  }

  private async readTokenEnvelope(tokenEnvelope: string | null): Promise<string | null> {
    if (tokenEnvelope === null) return null;
    try {
      const envelope = tokenEnvelopeSchema.parse(JSON.parse(tokenEnvelope) as unknown);
      const token = await decryptOverlayToken(envelope, this.getOverlayTokenPepper(), this.env.CAPSULE_ID);
      return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
    } catch {
      return null;
    }
  }

  private async mutateDockToken(request: Request, rotate: boolean): Promise<Response> {
    const session = this.requireSession(request);
    await this.requireCsrf(request, session);
    const input = overlayTokenMutationRequestSchema.parse(await readJson(request, 2_048));
    const pepper = this.getOverlayTokenPepper();
    const current = this.getDockToken();
    const currentGeneration = current?.generation ?? 0;
    if (
      current !== null &&
      current.generation === input.expectedGeneration + 1 &&
      current.requestId === input.requestId
    ) {
      if (current.creatingSessionHash !== session.session_hash) {
        throw new RequestError(409, "idempotency_mismatch", "Token-Anfrage wurde anders wiederholt.");
      }
      const token = await this.readDockTokenValue(current);
      if (token === null) {
        throw new RequestError(409, "idempotency_mismatch", "Token-Anfrage kann nicht wiederhergestellt werden.");
      }
      if (rotate) this.revokeTokenSockets("dock", input.expectedGeneration);
      return jsonResponse(
        dockTokenResponseSchema.parse({
          requestId: current.requestId,
          generation: current.generation,
          fingerprint: current.fingerprint,
          createdAt: current.createdAt,
          token,
        }),
      );
    }
    if (currentGeneration !== input.expectedGeneration || (rotate ? current === null : current !== null)) {
      throw new RequestError(409, "token_changed", "Der Dock-Tokenstatus hat sich geändert.");
    }
    const createdAt = nowIso();
    const generation = currentGeneration + 1;
    const token = randomToken(32);
    const tokenHash = await hmacHex(pepper, token);
    const tokenEnvelope = await encryptOverlayToken(token, pepper, this.env.CAPSULE_ID);
    const currentAfterCrypto = this.getDockToken();
    if (
      (currentAfterCrypto?.generation ?? 0) !== currentGeneration ||
      (rotate ? currentAfterCrypto === null : currentAfterCrypto !== null)
    ) {
      throw new RequestError(409, "token_changed", "Der Dock-Tokenstatus hat sich geändert.");
    }
    const fingerprint = tokenHash.slice(0, 8).toUpperCase();
    createChallengeRepository(this.createModuleContext()).upsertDockToken({
      tokenHash,
      tokenEnvelope: JSON.stringify(tokenEnvelope),
      fingerprint,
      generation,
      requestId: input.requestId,
      creatingSessionHash: session.session_hash,
      createdAt,
      lastUsedAt: null,
    });
    if (rotate) this.revokeTokenSockets("dock", currentGeneration);
    return jsonResponse(
      dockTokenResponseSchema.parse({
        requestId: input.requestId,
        generation,
        fingerprint,
        createdAt,
        token,
      }),
    );
  }

  private async uploadMedia(request: Request): Promise<Response> {
    const session = this.requireSession(request);
    await this.requireCsrf(request, session);
    if (request.headers.get("content-type") !== "image/webp") {
      throw new RequestError(422, "validation_failed", "Portrait muss als WebP hochgeladen werden.");
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 262_144) {
      throw new RequestError(413, "payload_too_large", "Portrait darf höchstens 256 KiB groß sein.");
    }
    let dimensions: { width: number; height: number };
    try {
      dimensions = inspectWebP(bytes);
    } catch {
      throw new RequestError(422, "validation_failed", "Portrait ist kein gültiges WebP mit 32–512 Pixeln.");
    }
    const contentHash = await sha256Hex(bytes);
    const leaseExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString();
    const historyChanged = this.ctx.storage.transactionSync(() => {
      const now = nowIso();
      this.ctx.storage.sql.exec("DELETE FROM media_leases WHERE expires_at <= ?", now);
      this.deleteCollectibleMedia(now);

      let existing = this.ctx.storage.sql
        .exec<{ content_hash: string }>(
          "SELECT content_hash FROM media_blobs WHERE content_hash = ?",
          contentHash,
        )
        .toArray()[0];
      let prunedHistory = false;
      while (existing === undefined && !this.mediaHasRoomFor(bytes.byteLength)) {
        const oldest = this.ctx.storage.sql
          .exec<{ revision: number }>(
            "SELECT revision FROM state_history ORDER BY revision ASC LIMIT 1",
          )
          .toArray()[0];
        if (oldest === undefined) {
          throw new RequestError(
            413,
            "media_quota_exceeded",
            "Medienlimit dieser Installation erreicht.",
          );
        }
        this.ctx.storage.sql.exec(
          "DELETE FROM state_history WHERE revision = ?",
          oldest.revision,
        );
        prunedHistory = true;
        this.deleteCollectibleMedia(now);
        existing = this.ctx.storage.sql
          .exec<{ content_hash: string }>(
            "SELECT content_hash FROM media_blobs WHERE content_hash = ?",
            contentHash,
          )
          .toArray()[0];
      }

      if (existing === undefined) {
        this.ctx.storage.sql.exec(
          `INSERT INTO media_blobs(
            content_hash, mime_type, width, height, byte_length, bytes, created_at
          ) VALUES (?, 'image/webp', ?, ?, ?, ?, ?)`,
          contentHash,
          dimensions.width,
          dimensions.height,
          bytes.byteLength,
          bytes,
          now,
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO media_leases(content_hash, editor_session_hash, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT(content_hash, editor_session_hash) DO UPDATE SET expires_at = excluded.expires_at`,
        contentHash,
        session.session_hash,
        leaseExpiresAt,
      );
      return prunedHistory;
    });
    if (historyChanged) this.broadcastHistoryChanged();
    return jsonResponse(
      uploadResponseSchema.parse({
        portrait: { kind: "uploaded", contentHash },
        ...dimensions,
        byteLength: bytes.byteLength,
        leaseExpiresAt,
      }),
    );
  }

  private async renewMediaLeases(request: Request): Promise<Response> {
    const session = this.requireSession(request);
    await this.requireCsrf(request, session);
    const input = renewMediaLeasesRequestSchema.parse(await readJson(request, 4_096));
    const leaseExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString();
    const leases: Array<{ contentHash: string; leaseExpiresAt: string }> = [];
    this.ctx.storage.transactionSync(() => {
      for (const contentHash of [...new Set(input.contentHashes)]) {
        const exists = this.ctx.storage.sql
          .exec<{ content_hash: string }>(
            "SELECT content_hash FROM media_blobs WHERE content_hash = ?",
            contentHash,
          )
          .toArray()[0];
        if (exists === undefined) continue;
        this.ctx.storage.sql.exec(
          `INSERT INTO media_leases(content_hash, editor_session_hash, expires_at)
          VALUES (?, ?, ?)
          ON CONFLICT(content_hash, editor_session_hash) DO UPDATE SET expires_at = excluded.expires_at`,
          contentHash,
          session.session_hash,
          leaseExpiresAt,
        );
        leases.push({ contentHash, leaseExpiresAt });
      }
    });
    return jsonResponse(renewMediaLeasesResponseSchema.parse({ leases }));
  }

  private async getMedia(request: Request, contentHash: string): Promise<Response> {
    if (!/^[a-f0-9]{64}$/.test(contentHash)) {
      throw new RequestError(404, "not_found", "Medium nicht gefunden.");
    }
    const sessionHash = request.headers.get("x-session-hash");
    let authorized =
      sessionHash !== null && this.getSessionByHash(sessionHash, false) !== null;
    if (!authorized) {
      const token = request.headers.get("x-overlay-token");
      const row = this.getOverlayToken();
      if (token !== null && row !== null) {
        const hash = await hmacHex(this.getOverlayTokenPepper(), token);
        authorized = timingSafeEqual(row.token_hash, hash);
      }
    }
    if (!authorized) throw new RequestError(403, "forbidden", "Medium ist nicht autorisiert.");
    const row = this.ctx.storage.sql
      .exec<{ mime_type: string; bytes: ArrayBuffer }>(
        "SELECT mime_type, bytes FROM media_blobs WHERE content_hash = ?",
        contentHash,
      )
      .toArray()[0];
    if (row === undefined) throw new RequestError(404, "not_found", "Medium nicht gefunden.");
    return new Response(row.bytes, {
      headers: {
        "content-type": row.mime_type,
        "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff",
      },
    });
  }

  /**
   * Zählt nur Sockets, die tatsächlich noch Daten annehmen. Ein gerade
   * geschlossener Socket steht kurzzeitig weiter in getWebSockets(), darf einen
   * Platz aber nicht mehr blockieren.
   */
  private activeSocketCount(
    tag: "editor" | "overlay" | "composite" | "challenge" | "dock",
  ): number {
    return this.ctx.getWebSockets(tag)
      .filter((socket) => socket.readyState === WebSocket.OPEN).length;
  }

  /**
   * Räumt tote Socket-Plätze ab und liefert die verbleibende Belegung.
   *
   * Hibernierende WebSockets verschwinden nur, wenn der Client sauber schließt.
   * Eine abgestürzte OBS-Browserquelle oder ein neu eingehängtes Widget-iframe
   * hinterlässt deshalb einen Socket, der nicht mehr offen ist, aber weiter einen
   * Platz belegt.
   *
   * Eine offene Verbindung wird nur angefasst, wenn ALLE Plätze belegt sind und ihr
   * Heartbeat-Zeitstempel zu alt ist. Bei fünfzehn Plätzen passiert im Normalbetrieb
   * also nichts — die Bereinigung ist ein Notventil gegen die Selbstsperre, kein
   * laufender Dienst.
   *
   * Eine ältere, noch heartbeatende Verbindung wird auch dann nicht verdrängt. Das
   * erzeugte ein Karussell: jede neue Quelle warf die älteste hinaus, die sofort neu
   * verband und die nächste hinauswarf — die Anzeige verschwand im Sekundentakt. Wer
   * mehr gleichzeitige Quellen braucht, bekommt mehr Plätze, keine Rotation.
   */
  private reclaimSocketSlots(
    tag: "editor" | "overlay" | "composite" | "challenge" | "dock",
    socketLimit: number,
  ): number {
    // Nicht mehr offene Sockets sind zweifelsfrei weg und werden immer abgeräumt.
    for (const socket of this.ctx.getWebSockets(tag)) {
      if (socket.readyState === WebSocket.OPEN) continue;
      try {
        socket.close(4004, "stale_socket");
      } catch {
        // Ein bereits geschlossener Socket wirft hier; er zählt ohnehin nicht mehr.
      }
    }

    const active = this.activeSocketCount(tag);
    // Solange ein Platz frei ist, wird keine offene Verbindung angefasst. Für eine
    // stille Verbindung gibt es keine sichere Frist: eine eingefrorene Seite
    // (Ruhezustand, Tab-Freeze, Netzausfall) sieht beliebig lange tot aus und lebt
    // trotzdem. Sie zu schließen, obwohl niemand ihren Platz braucht, ist Schaden
    // ohne Nutzen — genau daran ist die Anzeige zweimal verschwunden.
    if (active < socketLimit) return active;

    for (const socket of this.ctx.getWebSockets(tag)) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const lastHeartbeatAt = this.ctx.getWebSocketAutoResponseTimestamp(socket);
      // null bedeutet: Dieser Socket hat noch nie gepingt. Ein offenes altes
      // Bundle nach einem Deploy darf deshalb nicht geschlossen werden — es
      // pingt nie, verbindet sich nach dem Rauswurf sofort neu und erzeugt
      // genau das Karussell, das die Bereinigung verhindern soll.
      if (
        lastHeartbeatAt === null
        || Date.now() - lastHeartbeatAt.getTime() <= SOCKET_STALE_AFTER_MS
      ) continue;
      try {
        socket.close(4006, "stale_heartbeat");
      } catch {
        // Ein bereits geschlossener Socket darf die übrigen Plätze nicht blockieren.
      }
    }
    return this.activeSocketCount(tag);
  }

  private connectEditor(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new RequestError(400, "bad_request", "WebSocket-Upgrade erforderlich.");
    }
    if (this.reclaimSocketSlots("editor", limits.maxEditorSockets) >= limits.maxEditorSockets) {
      throw new RequestError(429, "socket_limit", "Zu viele Editor-Verbindungen.");
    }
    const session = this.requireSession(request);
    const tabId = this.requireTabId(request);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["editor"]);
    server.serializeAttachment({
      version: 1,
      kind: "editor",
      connectionId: crypto.randomUUID(),
      sessionRecordId: session.session_hash,
      sessionGeneration: session.generation,
      tabId,
      connectedAt: nowIso(),
    } satisfies SocketAttachment);
    server.send(JSON.stringify({ type: "snapshot", state: normalizeStateForRead(this.getRequiredState()) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Gemeinsamer Verbindungsaufbau fuer Overlay- und Composite-Sockets: Upgrade-
  // Pruefung, Limit-Check, Token-Verifikation, Verbindungsaufbau, Snapshot.
  // Der zweite Limit-Check (nach new WebSocketPair()) ist Absicht: zwischen den
  // beiden Checks liegt das await hmacHex(...) oben, also ein TOCTOU-Fenster.
  private async connectPresenceSocket(
    request: Request,
    tag: "overlay" | "composite",
    socketLimit: number,
    limitErrorMessage: string,
  ): Promise<{ client: WebSocket; server: WebSocket }> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new RequestError(400, "bad_request", "WebSocket-Upgrade erforderlich.");
    }
    if (this.reclaimSocketSlots(tag, socketLimit) >= socketLimit) {
      throw new RequestError(429, "socket_limit", limitErrorMessage);
    }
    const token = request.headers.get("x-overlay-token");
    if (token === null) throw new RequestError(403, "token_invalid", "OBS-Token ungültig.");
    const hash = await hmacHex(this.getOverlayTokenPepper(), token);
    const row = this.getOverlayToken();
    if (row === null || !timingSafeEqual(row.token_hash, hash)) {
      throw new RequestError(403, "token_invalid", "OBS-Token ungültig.");
    }
    this.ctx.storage.sql.exec(
      "UPDATE overlay_tokens SET last_used_at = ? WHERE singleton = 1",
      nowIso(),
    );
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (this.activeSocketCount(tag) >= socketLimit) {
      throw new RequestError(429, "socket_limit", limitErrorMessage);
    }
    this.ctx.acceptWebSocket(server, [tag]);
    server.serializeAttachment({
      version: 1,
      kind: tag,
      connectionId: crypto.randomUUID(),
      tokenGeneration: row.generation,
      connectedAt: nowIso(),
    } satisfies SocketAttachment);
    server.send(JSON.stringify({ type: "snapshot", state: normalizeStateForRead(this.getRequiredState()) }));
    return { client, server };
  }

  private async connectOverlay(request: Request): Promise<Response> {
    const { client } = await this.connectPresenceSocket(
      request,
      "overlay",
      limits.maxOverlaySockets,
      "Zu viele Overlay-Verbindungen.",
    );
    this.broadcastOverlayPresence();
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": OVERLAY_SOCKET_PROTOCOL },
    });
  }

  private async connectComposite(request: Request): Promise<Response> {
    const { client, server } = await this.connectPresenceSocket(
      request,
      "composite",
      limits.maxCompositeSockets,
      "Zu viele Composite-Verbindungen.",
    );
    server.send(JSON.stringify(createChallengeService(this.createModuleContext()).readChallengeUpdate()));
    this.broadcastOverlayPresence();
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": OVERLAY_SOCKET_PROTOCOL },
    });
  }

  private async connectChallenge(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new RequestError(400, "bad_request", "WebSocket-Upgrade erforderlich.");
    }
    if (this.reclaimSocketSlots("challenge", limits.maxChallengeSockets) >= limits.maxChallengeSockets) {
      throw new RequestError(429, "socket_limit", "Zu viele Challenge-Verbindungen.");
    }
    const token = request.headers.get("x-overlay-token");
    if (token === null) throw new RequestError(403, "token_invalid", "OBS-Token ungültig.");
    const hash = await hmacHex(this.getOverlayTokenPepper(), token);
    const row = this.getOverlayToken();
    if (row === null || !timingSafeEqual(row.token_hash, hash)) {
      throw new RequestError(403, "token_invalid", "OBS-Token ungültig.");
    }
    this.ctx.storage.sql.exec(
      "UPDATE overlay_tokens SET last_used_at = ? WHERE singleton = 1",
      nowIso(),
    );
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (this.activeSocketCount("challenge") >= limits.maxChallengeSockets) {
      throw new RequestError(429, "socket_limit", "Zu viele Challenge-Verbindungen.");
    }
    this.ctx.acceptWebSocket(server, ["challenge"]);
    server.serializeAttachment({
      version: 1,
      kind: "challenge",
      connectionId: crypto.randomUUID(),
      tokenGeneration: row.generation,
      connectedAt: nowIso(),
    } satisfies SocketAttachment);
    server.send(JSON.stringify(createChallengeService(this.createModuleContext()).readChallengeUpdate()));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": OVERLAY_SOCKET_PROTOCOL },
    });
  }

  private async connectDock(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new RequestError(400, "bad_request", "WebSocket-Upgrade erforderlich.");
    }
    if (this.reclaimSocketSlots("dock", limits.maxDockSockets) >= limits.maxDockSockets) {
      throw new RequestError(429, "socket_limit", "Zu viele Dock-Verbindungen.");
    }
    const row = await this.requireDockToken(request);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (this.activeSocketCount("dock") >= limits.maxDockSockets) {
      throw new RequestError(429, "socket_limit", "Zu viele Dock-Verbindungen.");
    }
    this.ctx.acceptWebSocket(server, ["dock"]);
    server.serializeAttachment({
      version: 1,
      kind: "dock",
      connectionId: crypto.randomUUID(),
      tokenGeneration: row.generation,
      connectedAt: nowIso(),
    } satisfies SocketAttachment);
    server.send(JSON.stringify(createChallengeService(this.createModuleContext()).readChallengeUpdate()));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": DOCK_SOCKET_PROTOCOL },
    });
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const attachment = this.readAttachment(socket);
    if (attachment === null) {
      socket.close(1011, "invalid_attachment");
      return;
    }
    if (attachment.kind === "editor") {
      if (this.closeEditorSocketIfSessionRevoked(socket, attachment)) return;
    } else if (this.closeTokenSocketIfRevoked(socket, attachment)) {
      return;
    }
    const byteLength =
      typeof message === "string"
        ? new TextEncoder().encode(message).byteLength
        : message.byteLength;
    if (byteLength > 98_304) return;
    try {
      const parsed = clientMessageSchema.safeParse(
        JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)),
      );
      if (parsed.success) {
        socket.send(
          JSON.stringify({
            type: "time_sync",
            clientTimestamp: parsed.data.clientTimestamp,
            serverTime: nowIso(),
          }),
        );
      }
    } catch {
      socket.close(1003, "invalid_message");
    }
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): void {
    // Nur 1000 und der Anwendungsbereich 3000-4999 duerfen zurueckgespiegelt werden.
    // Ein Client, der ohne Code schliesst, erzeugt hier 1005, ein Abbruch 1006; beides
    // weist workerd mit InvalidAccessError zurueck.
    if (code === 1000 || (code >= 3000 && code <= 4999)) {
      socket.close(code, reason);
    } else {
      socket.close();
    }
    void wasClean;
    if (this.isPresenceSocket(this.readAttachment(socket))) {
      this.broadcastOverlayPresence(socket);
    }
  }

  override webSocketError(socket: WebSocket): void {
    socket.close(1011, "socket_error");
    if (this.isPresenceSocket(this.readAttachment(socket))) {
      this.broadcastOverlayPresence(socket);
    }
  }

  private ensureState(session: SessionRow): ChannelState {
    const existing = this.readState();
    if (existing !== null) return existing;
    const state = createDefaultState(actorFromSession(session), nowIso());
    this.writeState(state);
    return state;
  }

  private readState(): ChannelState | null {
    const row = this.ctx.storage.sql
      .exec<StateRow>("SELECT * FROM channel_state WHERE singleton = 1")
      .toArray()[0];
    if (row === undefined) return null;
    const draft = channelStateDraftSchema.parse(JSON.parse(row.state_json));
    return channelStateSchema.parse({
      ...draft,
      revision: row.revision,
      overlayEnabled: row.overlay_enabled === 1,
      updatedAt: row.updated_at,
      updatedBy: {
        twitchUserId: row.updated_by_id,
        displayName: row.updated_by_name,
      },
    });
  }

  private getRequiredState(): ChannelState {
    const state = this.readState();
    if (state === null) throw new Error("State not initialized");
    return state;
  }

  private writeState(state: ChannelState): void {
    const draft = draftFromState(state);
    this.ctx.storage.sql.exec(
      `INSERT INTO channel_state(
        singleton, revision, overlay_enabled, state_json, updated_at, updated_by_id, updated_by_name
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        revision = excluded.revision,
        overlay_enabled = excluded.overlay_enabled,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at,
        updated_by_id = excluded.updated_by_id,
        updated_by_name = excluded.updated_by_name`,
      state.revision,
      state.overlayEnabled ? 1 : 0,
      JSON.stringify(draft),
      state.updatedAt,
      state.updatedBy.twitchUserId,
      state.updatedBy.displayName,
    );
  }

  private insertHistory(state: ChannelState, summary: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO state_history(revision, snapshot_json, created_at, summary) VALUES (?, ?, ?, ?)",
      state.revision,
      JSON.stringify(state),
      state.updatedAt,
      summary,
    );
  }

  private makeAudit(
    revision: number,
    action: AuditEntry["action"],
    session: SessionRow,
    summary: string,
    createdAt: string,
  ): AuditEntry {
    return auditEntrySchema.parse({
      id: crypto.randomUUID(),
      revision,
      action,
      actor: actorFromSession(session),
      summary,
      createdAt,
    });
  }

  private insertAudit(entry: AuditEntry): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO audit_log(
        id, revision, action, actor_id, actor_name, summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.revision,
      entry.action,
      entry.actor.twitchUserId,
      entry.actor.displayName,
      entry.summary,
      entry.createdAt,
    );
  }

  private getAuditEntries(): AuditEntry[] {
    return this.ctx.storage.sql
      .exec<{
        id: string;
        revision: number;
        action: AuditEntry["action"];
        actor_id: string;
        actor_name: string;
        summary: string;
        created_at: string;
      }>("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 50")
      .toArray()
      .map((row) =>
        auditEntrySchema.parse({
          id: row.id,
          revision: row.revision,
          action: row.action,
          actor: { twitchUserId: row.actor_id, displayName: row.actor_name },
          summary: row.summary,
          createdAt: row.created_at,
        }),
      );
  }

  private getUndoTargets(): UndoTarget[] {
    return this.ctx.storage.sql
      .exec<{ revision: number; created_at: string; summary: string }>(
        "SELECT revision, created_at, summary FROM state_history ORDER BY revision DESC LIMIT 20",
      )
      .toArray()
      .map((row) => ({
        revision: row.revision,
        createdAt: row.created_at,
        summary: row.summary,
      }));
  }

  private pruneHistoryAndAudit(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM state_history WHERE revision NOT IN (SELECT revision FROM state_history ORDER BY revision DESC LIMIT 20)",
    );
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
    this.ctx.storage.sql.exec(
      "DELETE FROM audit_log WHERE created_at < ? OR id NOT IN (SELECT id FROM audit_log ORDER BY created_at DESC LIMIT 500)",
      cutoff,
    );
  }

  private mediaHasRoomFor(byteLength: number): boolean {
    const usage = this.ctx.storage.sql
      .exec<{ count: number; bytes: number }>(
        "SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes FROM media_blobs",
      )
      .toArray()[0];
    return (
      usage !== undefined &&
      usage.count < maxMediaBlobs &&
      usage.bytes + byteLength <= limits.maxMediaBytes
    );
  }

  private deleteCollectibleMedia(now: string): void {
    const protectedHashes = new Set<string>();
    const protectState = (state: ChannelState | ChannelStateDraft): void => {
      const portraits = [
        state.player.portrait,
        state.pet?.portrait,
        ...state.group.map((member) => member.portrait),
      ];
      for (const portrait of portraits) {
        if (portrait?.kind === "uploaded") protectedHashes.add(portrait.contentHash);
      }
    };

    const current = this.ctx.storage.sql
      .exec<{ state_json: string }>("SELECT state_json FROM channel_state WHERE singleton = 1")
      .toArray()[0];
    if (current !== undefined) {
      protectState(channelStateDraftSchema.parse(JSON.parse(current.state_json)));
    }
    for (const row of this.ctx.storage.sql
      .exec<{ snapshot_json: string }>("SELECT snapshot_json FROM state_history")
      .toArray()) {
      protectState(channelStateSchema.parse(JSON.parse(row.snapshot_json)));
    }
    for (const lease of this.ctx.storage.sql
      .exec<{ content_hash: string }>(
        "SELECT content_hash FROM media_leases WHERE expires_at > ?",
        now,
      )
      .toArray()) {
      protectedHashes.add(lease.content_hash);
    }
    for (const blob of this.ctx.storage.sql
      .exec<{ content_hash: string }>("SELECT content_hash FROM media_blobs")
      .toArray()) {
      if (!protectedHashes.has(blob.content_hash)) {
        this.ctx.storage.sql.exec(
          "DELETE FROM media_blobs WHERE content_hash = ?",
          blob.content_hash,
        );
      }
    }
  }

  private requireSession(request: Request): SessionRow {
    const hash = request.headers.get("x-session-hash");
    if (hash === null) throw new RequestError(401, "unauthorized", "Bitte mit Twitch anmelden.");
    const session = this.getSessionByHash(hash, true);
    if (session === null) throw new RequestError(401, "unauthorized", "Sitzung abgelaufen.");
    if (Date.parse(session.role_checked_at) + 60 * 60 * 1_000 <= Date.now()) {
      throw new RequestError(403, "role_ineligible", "Twitch-Berechtigung muss neu geprüft werden.");
    }
    return session;
  }

  private getSessionByHash(hash: string, touch: boolean): SessionRow | null {
    const row = this.ctx.storage.sql
      .exec<SessionRow>("SELECT * FROM editor_sessions WHERE session_hash = ?", hash)
      .toArray()[0];
    if (row === undefined) return null;
    const now = Date.now();
    if (Date.parse(row.idle_expires_at) <= now || Date.parse(row.absolute_expires_at) <= now) {
      this.ctx.storage.sql.exec("DELETE FROM csrf_tokens WHERE session_hash = ?", hash);
      this.ctx.storage.sql.exec("DELETE FROM editor_sessions WHERE session_hash = ?", hash);
      return null;
    }
    if (touch) {
      const maximumIdle = Math.min(
        now + 24 * 60 * 60 * 1_000,
        Date.parse(row.absolute_expires_at),
      );
      const idleExpiresAt = new Date(maximumIdle).toISOString();
      this.ctx.storage.sql.exec(
        "UPDATE editor_sessions SET idle_expires_at = ? WHERE session_hash = ?",
        idleExpiresAt,
        hash,
      );
      row.idle_expires_at = idleExpiresAt;
    }
    return row;
  }

  private requireTabId(request: Request): string {
    const value = request.headers.get("x-editor-tab");
    if (value === null || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) {
      throw new RequestError(400, "bad_request", "Editor-Tab fehlt.");
    }
    return value;
  }

  private async requireCsrf(request: Request, session: SessionRow): Promise<void> {
    const tabId = this.requireTabId(request);
    const token = request.headers.get("x-csrf-token");
    if (token === null) throw new RequestError(403, "csrf_invalid", "Sicherheits-Token fehlt.");
    const hash = await sha256Hex(token);
    const row = this.ctx.storage.sql
      .exec<{
        token_hash: string;
        previous_token_hash: string | null;
        previous_expires_at: string | null;
      }>(
        "SELECT token_hash, previous_token_hash, previous_expires_at FROM csrf_tokens WHERE session_hash = ? AND tab_id = ?",
        session.session_hash,
        tabId,
      )
      .toArray()[0];
    const validCurrent = row !== undefined && timingSafeEqual(row.token_hash, hash);
    const validPrevious =
      row?.previous_token_hash !== null &&
      row?.previous_token_hash !== undefined &&
      row.previous_expires_at !== null &&
      Date.parse(row.previous_expires_at) > Date.now() &&
      timingSafeEqual(row.previous_token_hash, hash);
    if (!validCurrent && !validPrevious) {
      throw new RequestError(403, "csrf_invalid", "Sicherheits-Token ungültig.");
    }
  }

  private async rotateCsrf(sessionHash: string, tabId: string): Promise<string> {
    const csrfToken = randomToken(24);
    const tokenHash = await sha256Hex(csrfToken);
    const existing = this.ctx.storage.sql
      .exec<{ token_hash: string }>(
        "SELECT token_hash FROM csrf_tokens WHERE session_hash = ? AND tab_id = ?",
        sessionHash,
        tabId,
      )
      .toArray()[0];
    const previousExpiresAt = new Date(Date.now() + 5 * 60 * 1_000).toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO csrf_tokens(
        session_hash, tab_id, token_hash, previous_token_hash, previous_expires_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_hash, tab_id) DO UPDATE SET
        previous_token_hash = csrf_tokens.token_hash,
        previous_expires_at = excluded.previous_expires_at,
        token_hash = excluded.token_hash`,
      sessionHash,
      tabId,
      tokenHash,
      existing?.token_hash ?? null,
      previousExpiresAt,
    );
    return csrfToken;
  }

  private getOverlayTokenPepper(): string {
    if (this.env.OVERLAY_TOKEN_PEPPER !== undefined) return this.env.OVERLAY_TOKEN_PEPPER;
    if (this.env.APP_ENV === "local") return "local-overlay-token-pepper";
    throw new RequestError(503, "misconfigured", "OVERLAY_TOKEN_PEPPER fehlt.");
  }

  private getOverlayToken(): OverlayTokenRow | null {
    return (
      this.ctx.storage.sql
        .exec<OverlayTokenRow>("SELECT * FROM overlay_tokens WHERE singleton = 1")
        .toArray()[0] ?? null
    );
  }

  private getDockToken(): DockTokenRecord | null {
    return createChallengeRepository(this.createModuleContext()).readDockToken();
  }

  private async requireDockToken(request: Request): Promise<DockTokenRecord> {
    const token = request.headers.get("x-dock-token");
    if (token === null || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new RequestError(403, "token_invalid", "Dock-Token ungültig.");
    }
    const hash = await hmacHex(this.getOverlayTokenPepper(), token);
    const row = this.getDockToken();
    if (row === null || !timingSafeEqual(row.tokenHash, hash)) {
      throw new RequestError(403, "token_invalid", "Dock-Token ungültig.");
    }
    this.ctx.storage.sql.exec(
      "UPDATE wc_dock_tokens SET last_used_at = ? WHERE singleton = 1",
      nowIso(),
    );
    return row;
  }

  // Bester bekannter Twitch-Kanalname des bearbeiteten Broadcasters, aus dem
  // Cache befüllt via Login/Revalidierung. Kein Treffer ist kein Fehler: das
  // Frontend fällt dann auf capsule.name zurück.
  private getBroadcasterProfile(): { id: string; login: string; displayName: string } | null {
    const row = this.ctx.storage.sql
      .exec<{ twitch_user_id: string; login: string; display_name: string }>(
        "SELECT twitch_user_id, login, display_name FROM twitch_user_cache WHERE twitch_user_id = ?",
        this.env.BROADCASTER_ID,
      )
      .toArray()[0];
    if (row === undefined) return null;
    return { id: row.twitch_user_id, login: row.login, displayName: row.display_name };
  }

  private validateCatalog(draft: ChannelStateDraft): void {
    const knownIds = new Set(EFFECT_CATALOG.map((definition) => definition.id));
    const knownIconIds = new Set(EFFECT_CATALOG.map((definition) => definition.iconId));
    draft.effects.forEach((effect, index) => {
      if (effect.catalogId !== null && !knownIds.has(effect.catalogId)) {
        throw new RequestError(422, "validation_failed", "Unbekannter Katalogeffekt.", {
          fieldErrors: { [`effects[${String(index)}].catalogId`]: "Effekt nicht im Katalog." },
        });
      }
      if (!knownIconIds.has(effect.iconId)) {
        throw new RequestError(422, "validation_failed", "Unbekanntes Effekt-Icon.", {
          fieldErrors: { [`effects[${String(index)}].iconId`]: "Icon nicht im Katalog." },
        });
      }
      const definition = getEffectDefinition(effect.catalogId);
      const maximum = definition?.maxStacks ?? 1;
      if (effect.stacks !== null && effect.stacks > maximum) {
        throw new RequestError(422, "validation_failed", "Zu viele Effektstapel.", {
          fieldErrors: { [`effects[${String(index)}].stacks`]: `Maximal ${String(maximum)}.` },
        });
      }
    });
  }

  private validateMediaReferences(
    draft: ChannelStateDraft,
    current: ChannelState,
    session: SessionRow,
  ): void {
    const nextPortraits = [draft.player.portrait, draft.pet?.portrait, ...draft.group.map((member) => member.portrait)];
    const currentPortraits = [
      current.player.portrait,
      current.pet?.portrait,
      ...current.group.map((member) => member.portrait),
    ];
    const currentHashes = new Set(
      currentPortraits.flatMap((portrait) =>
        portrait?.kind === "uploaded" ? [portrait.contentHash] : [],
      ),
    );
    for (const portrait of nextPortraits) {
      if (portrait?.kind !== "uploaded" || currentHashes.has(portrait.contentHash)) continue;
      const lease = this.ctx.storage.sql
        .exec<{ expires_at: string }>(
          `SELECT expires_at FROM media_leases
          WHERE content_hash = ? AND editor_session_hash = ?`,
          portrait.contentHash,
          session.session_hash,
        )
        .toArray()[0];
      if (lease === undefined || Date.parse(lease.expires_at) <= Date.now()) {
        throw new RequestError(403, "forbidden", "Portrait-Lease fehlt oder ist abgelaufen.");
      }
    }
  }

  private canonicalizeTwitchGroup(draft: ChannelStateDraft): ChannelStateDraft {
    return channelStateDraftSchema.parse({
      ...draft,
      group: draft.group.map((member, index) => {
        if (member.source !== "twitch" || member.twitchUserId === null) return member;
        const cached = this.ctx.storage.sql
          .exec<{
            twitch_user_id: string;
            display_name: string;
            portrait_url: string;
          }>(
            "SELECT twitch_user_id, display_name, portrait_url FROM twitch_user_cache WHERE twitch_user_id = ?",
            member.twitchUserId,
          )
          .toArray()[0];
        if (cached === undefined) {
          throw new RequestError(422, "validation_failed", "Twitch-Gast muss zuerst gesucht werden.", {
            fieldErrors: { [`group[${String(index)}].twitchUserId`]: "Gastdaten nicht bestätigt." },
          });
        }
        return {
          ...member,
          name: cached.display_name,
          portrait: {
            kind: "twitch" as const,
            userId: cached.twitch_user_id,
            url: cached.portrait_url,
          },
        };
      }),
    });
  }

  // Sendet an jeden Socket einzeln: widerrufene oder abgelaufene Sockets werden
  // geschlossen statt beliefert, und ein fehlschlagender Socket darf die
  // Übertragung an die übrigen nicht abbrechen.
  private sendToSockets(sockets: WebSocket[], message: string): void {
    for (const socket of sockets) {
      const attachment = this.readAttachment(socket);
      if (attachment?.kind === "editor") {
        if (this.closeEditorSocketIfSessionRevoked(socket, attachment)) continue;
      } else if (
        attachment?.kind === "overlay" ||
        attachment?.kind === "composite" ||
        attachment?.kind === "challenge" ||
        attachment?.kind === "dock"
      ) {
        if (this.closeTokenSocketIfRevoked(socket, attachment)) continue;
      }
      try {
        socket.send(message);
      } catch {
        // Ein einzelner fehlschlagender Socket darf die Übertragung an andere nicht abbrechen.
      }
    }
  }

  private broadcastState(state: ChannelState): void {
    const message = JSON.stringify({ type: "state_committed", state });
    this.sendToSockets(
      [
        ...this.ctx.getWebSockets("editor"),
        ...this.ctx.getWebSockets("overlay"),
        ...this.ctx.getWebSockets("composite"),
      ],
      message,
    );
  }

  private broadcast(tags: readonly string[], payload: unknown): void {
    const targetTags = new Set(tags);
    // Editor und Composite tragen beide Modul-Nachrichten; sie bleiben
    // gemeinsame Host-Sockets und erhalten deshalb Challenge-Updates weiter.
    if (tags.includes("challenge") || tags.includes("dock")) {
      targetTags.add("editor");
      targetTags.add("composite");
    }
    this.sendToSockets(
      [...targetTags].flatMap((tag) => this.ctx.getWebSockets(tag)),
      JSON.stringify(payload),
    );
  }

  private revokeTokenSockets(
    tag: string,
    tokenGeneration?: number,
  ): void {
    const message = JSON.stringify({ type: "token_revoked" });
    for (const socket of this.ctx.getWebSockets(tag)) {
      if (tokenGeneration !== undefined) {
        const attachment = this.readAttachment(socket);
        if (attachment !== null && attachment.kind !== "editor" && attachment.tokenGeneration !== tokenGeneration) {
          continue;
        }
      }
      try {
        socket.send(message);
      } catch {
        // Ein bereits abgerissener Socket darf die übrigen Widerrufe nicht verhindern.
      }
      try {
        socket.close(4003, "token_revoked");
      } catch {
        // Ein bereits geschlossener Socket darf die übrigen Widerrufe nicht verhindern.
      }
    }
  }

  private broadcastHistoryChanged(): void {
    const message = JSON.stringify({
      type: "history_changed",
      undoTargets: this.getUndoTargets(),
    });
    this.sendToSockets(this.ctx.getWebSockets("editor"), message);
  }

  private broadcastAudit(entry: AuditEntry, undoTargets: UndoTarget[]): void {
    const message = JSON.stringify({ type: "audit_appended", entry, undoTargets });
    this.sendToSockets(this.ctx.getWebSockets("editor"), message);
  }

  // Wird sowohl nach einer neuen Overlay-/Composite-Verbindung als auch beim
  // Schliessen/Fehler eines solchen Sockets aufgerufen. `excludeSocket` blendet
  // den Socket aus, der sich gerade schliesst, weil getWebSockets ihn noch
  // enthalten kann.
  private broadcastOverlayPresence(excludeSocket?: WebSocket): void {
    const connectedSockets = this.countPresenceSockets(excludeSocket);
    const message = JSON.stringify({ type: "overlay_presence", connectedSockets });
    this.sendToSockets(this.ctx.getWebSockets("editor"), message);
  }

  // Kombinierte Overlay-/Composite-Zaehlung fuer Bootstrap-Payload und
  // Presence-Broadcast. Die Math.min-Deckelung auf MAX_OVERLAY_SOCKETS ist
  // eine bewusste kosmetische Grenze wegen des Antwortschemas.
  private countPresenceSockets(excludeSocket?: WebSocket): number {
    return Math.min(
      MAX_OVERLAY_SOCKETS,
      this.ctx.getWebSockets("overlay").filter((socket) => socket !== excludeSocket).length
        + this.ctx.getWebSockets("composite").filter((socket) => socket !== excludeSocket).length,
    );
  }

  // Prüft, ob die Session hinter einem Editor-Socket noch existiert, nicht
  // abgelaufen ist und dessen generation zum Attachment passt; andernfalls wird
  // der Socket beendet.
  // Gibt zurück, ob der Socket geschlossen wurde (der Aufrufer soll ihn dann überspringen).
  private closeEditorSocketIfSessionRevoked(
    socket: WebSocket,
    attachment: Extract<SocketAttachment, { kind: "editor" }>,
  ): boolean {
    const row = this.getSessionByHash(attachment.sessionRecordId, false);
    if (
      row === null ||
      row.generation !== attachment.sessionGeneration ||
      Date.parse(row.role_checked_at) + 60 * 60 * 1_000 <= Date.now()
    ) {
      try {
        socket.close(4001, "session_revoked");
      } catch {
        // Ein bereits geschlossener Socket darf die übrigen Sockets nicht blockieren.
      }
      return true;
    }
    return false;
  }

  private closeTokenSocketIfRevoked(
    socket: WebSocket,
    attachment: Extract<SocketAttachment, { kind: "overlay" | "composite" | "challenge" | "dock" }>,
  ): boolean {
    let currentGeneration: number | null = null;
    try {
      currentGeneration = attachment.kind === "dock"
        ? this.getDockToken()?.generation ?? null
        : this.getOverlayToken()?.generation ?? null;
    } catch {
      // Ein unlesbarer Token-Datensatz ist kein Grund, den Socket weiter zu beliefern.
    }
    if (currentGeneration !== attachment.tokenGeneration) {
      try {
        socket.close(4003, "token_revoked");
      } catch {
        // Ein bereits geschlossener Socket darf die übrigen Sockets nicht blockieren.
      }
      return true;
    }
    return false;
  }

  // Prueft, ob ein Attachment zu einem der beiden Presence-relevanten Socket-
  // Typen gehoert (Overlay oder Composite).
  private isPresenceSocket(attachment: SocketAttachment | null): boolean {
    return attachment?.kind === "overlay" || attachment?.kind === "composite";
  }

  private readAttachment(socket: WebSocket): SocketAttachment | null {
    const attachment = socket.deserializeAttachment() as Partial<SocketAttachment> | null;
    if (
      attachment?.version !== 1 ||
      (attachment.kind !== "editor" &&
        attachment.kind !== "overlay" &&
        attachment.kind !== "composite" &&
        attachment.kind !== "challenge" &&
        attachment.kind !== "dock") ||
      typeof attachment.connectionId !== "string"
    ) {
      return null;
    }
    return attachment as SocketAttachment;
  }
}
