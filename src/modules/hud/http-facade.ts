import { z } from "zod";

import {
  saveRequestSchema,
  saveResponseSchema,
  visibilityRequestSchema,
  visibilityResponseSchema,
} from "../../shared/contracts/api";
import {
  channelStateDraftSchema,
  channelStateSchema,
  createDefaultState,
  normalizeStateForRead,
  stateByteLength,
  validateDraftForRelease,
  type ChannelState,
  type ChannelStateDraft,
} from "../../shared/contracts/state";
import { EFFECT_CATALOG, getEffectDefinition, validateEffectExpiries } from "../../shared/domain/effects";
import { jsonResponse, readJson, RequestError } from "../../worker/http";
import type {
  ModuleActor,
  ModuleContext,
  ModuleHandler,
  ModuleHistory,
  ModuleHistoryEntry,
  ModuleSession,
  ModuleState,
  SocketTag,
} from "../registry";

type StateRow = {
  revision: number;
  overlay_enabled: number;
  state_json: string;
  updated_at: string;
  updated_by_id: string;
  updated_by_name: string;
};

const nowIso = (): string => new Date().toISOString();

const actorFromSession = (session: ModuleSession): ModuleActor => ({
  twitchUserId: session.twitchUserId,
  displayName: session.displayName,
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
    before.placement.x !== after.placement.x
    || before.placement.y !== after.placement.y
    || before.placement.scale !== after.placement.scale
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

const readState = (ctx: ModuleContext): ChannelState | null => {
  const row = ctx.sql
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
};

const getRequiredState = (ctx: ModuleContext): ChannelState => {
  const state = readState(ctx);
  if (state === null) throw new Error("State not initialized");
  return state;
};

const writeState = (ctx: ModuleContext, state: ChannelState): void => {
  const draft = draftFromState(state);
  ctx.sql.exec(
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
};

const ensureState = (ctx: ModuleContext, actor: ModuleActor): ChannelState => {
  const existing = readState(ctx);
  if (existing !== null) return existing;
  const state = createDefaultState(actor, nowIso());
  writeState(ctx, state);
  return state;
};

const broadcastState = (
  ctx: ModuleContext,
  state: ChannelState,
  broadcastTags: readonly SocketTag[],
): void => {
  ctx.broadcast(broadcastTags, { type: "state_committed", state });
};

const createHudState = (broadcastTags: readonly SocketTag[]): ModuleState => ({
  ensure: ensureState,
  read: readState,
  getRequired: getRequiredState,
  write: writeState,
  broadcast: (ctx, state) => {
    broadcastState(ctx, state, broadcastTags);
  },
});

const parseSnapshotRecord = (json: string): Record<string, unknown> => {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("HUD-Historiensnapshot ist kein Objekt.");
  }
  return raw as Record<string, unknown>;
};

const targetFromSnapshot = (rawTarget: Record<string, unknown>, current: ChannelState): ChannelState =>
  normalizeStateForRead(
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

const restoreSummary = (
  rawTarget: Record<string, unknown>,
  revision: number,
): string => {
  const carriedForward = [
    Object.hasOwn(rawTarget, "compositeHudVisible") ? null : "HUD im Sammel-Overlay",
    Object.hasOwn(rawTarget, "compositeChallengesVisible") ? null : "Challenges im Sammel-Overlay",
  ].filter((label): label is string => label !== null);
  return carriedForward.length === 0
    ? `Revision ${String(revision)} wiederhergestellt`
    : `Revision ${String(revision)} wiederhergestellt (${carriedForward.join(" und ")} beibehalten)`;
};

const mediaContentHashesFromState = (state: ChannelState | ChannelStateDraft): readonly string[] => {
  const portraits = [
    state.player.portrait,
    state.pet?.portrait,
    ...state.group.map((member) => member.portrait),
  ];
  return portraits.flatMap((portrait) =>
    portrait?.kind === "uploaded" ? [portrait.contentHash] : [],
  );
};

const createHudHistory = (state: ModuleState): ModuleHistory => ({
  snapshot: (ctx): ModuleHistoryEntry => {
    const current = normalizeStateForRead(state.getRequired(ctx));
    return {
      revision: current.revision,
      json: JSON.stringify(current),
      createdAt: current.updatedAt,
    };
  },
  restore: (ctx, json) => {
    const actor = ctx.actor;
    if (actor === null) throw new Error("HUD-Zustand kann ohne Editor nicht wiederhergestellt werden.");
    const current = normalizeStateForRead(state.getRequired(ctx));
    const rawTarget = parseSnapshotRecord(json);
    const target = targetFromSnapshot(rawTarget, current);
    const next = channelStateSchema.parse({
      ...target,
      revision: current.revision + 1,
      overlayEnabled: current.overlayEnabled,
      updatedAt: ctx.now(),
      updatedBy: actor,
    });
    state.write(ctx, next);
  },
  restoreSummary: (_ctx, json, revision) => restoreSummary(parseSnapshotRecord(json), revision),
  mediaContentHashes: (json) => {
    const raw = parseSnapshotRecord(json);
    const fullState = channelStateSchema.safeParse(raw);
    if (fullState.success) return mediaContentHashesFromState(fullState.data);
    return mediaContentHashesFromState(channelStateDraftSchema.parse(raw));
  },
});

const validateCatalog = (draft: ChannelStateDraft): void => {
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
};

const validateMediaReferences = (
  ctx: ModuleContext,
  draft: ChannelStateDraft,
  current: ChannelState,
  session: ModuleSession,
): void => {
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
    const lease = ctx.sql
      .exec<{ expires_at: string }>(
        `SELECT expires_at FROM media_leases
        WHERE content_hash = ? AND editor_session_hash = ?`,
        portrait.contentHash,
        session.sessionHash,
      )
      .toArray()[0];
    if (lease === undefined || Date.parse(lease.expires_at) <= Date.now()) {
      throw new RequestError(403, "forbidden", "Portrait-Lease fehlt oder ist abgelaufen.");
    }
  }
};

const canonicalizeTwitchGroup = (ctx: ModuleContext, draft: ChannelStateDraft): ChannelStateDraft =>
  channelStateDraftSchema.parse({
    ...draft,
    group: draft.group.map((member, index) => {
      if (member.source !== "twitch" || member.twitchUserId === null) return member;
      const cached = ctx.sql
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

const createHudHttpHandler = (state: ModuleState): ModuleHandler =>
  async (request, ctx): Promise<Response | null> => {
    const url = new URL(request.url);

    if (request.method === "PUT" && url.pathname === "/state") {
      const session = await ctx.requireSessionAndCsrf(request);
      const input = saveRequestSchema.parse(await readJson(request, 131_072));
      const current = normalizeStateForRead(state.getRequired(ctx));
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
          canonicalizeTwitchGroup(ctx, filterExpiredEffectsFromDraft(input.state)),
          ctx.releaseStage,
        );
        validateEffectExpiries(draft.effects, current.effects);
      } catch (error) {
        if (error instanceof RequestError || error instanceof z.ZodError) throw error;
        if (error instanceof Error) {
          throw new RequestError(422, "validation_failed", error.message);
        }
        throw error;
      }
      validateCatalog(draft);
      validateMediaReferences(ctx, draft, current, session);
      if (stateByteLength(draft) > 65_536) {
        throw new RequestError(413, "payload_too_large", "Der HUD-Zustand überschreitet 64 KiB.");
      }
      const createdAt = ctx.now();
      const next = channelStateSchema.parse({
        ...draft,
        revision: current.revision + 1,
        overlayEnabled: current.overlayEnabled,
        updatedAt: createdAt,
        updatedBy: actorFromSession(session),
      });
      const action = forceReplace ? "force_replace" : "save";
      const summary = summarizeChange(current, next);
      ctx.recordHistory(summary);
      const audit = ctx.createAudit(next.revision, action, actorFromSession(session), summary, createdAt);
      ctx.transactionSync(() => {
        state.write(ctx, next);
        ctx.insertAudit(audit);
        ctx.pruneHistoryAndAudit();
      });
      state.broadcast(ctx, next);
      const undoTargets = ctx.getUndoTargets();
      ctx.broadcastAudit(audit, undoTargets);
      return jsonResponse(saveResponseSchema.parse({
        state: next,
        auditEntry: audit,
        undoTargets,
        serverTime: createdAt,
      }));
    }

    if (request.method === "POST" && url.pathname === "/overlay-visibility") {
      const session = await ctx.requireSessionAndCsrf(request);
      const input = visibilityRequestSchema.parse(await readJson(request, 1_024));
      const current = normalizeStateForRead(state.getRequired(ctx));
      if (current.overlayEnabled === input.enabled) {
        return jsonResponse(visibilityResponseSchema.parse({
          state: current,
          auditEntry: null,
          undoTargets: ctx.getUndoTargets(),
          serverTime: ctx.now(),
        }));
      }
      const createdAt = ctx.now();
      const next = channelStateSchema.parse({
        ...current,
        revision: current.revision + 1,
        overlayEnabled: input.enabled,
        updatedAt: createdAt,
        updatedBy: actorFromSession(session),
      });
      const action = input.enabled ? "overlay_enable" : "overlay_disable";
      const summary = input.enabled ? "Overlay aktiviert" : "Overlay deaktiviert";
      ctx.recordHistory(summary);
      const audit = ctx.createAudit(next.revision, action, actorFromSession(session), summary, createdAt);
      ctx.transactionSync(() => {
        state.write(ctx, next);
        ctx.insertAudit(audit);
        ctx.pruneHistoryAndAudit();
      });
      state.broadcast(ctx, next);
      const undoTargets = ctx.getUndoTargets();
      ctx.broadcastAudit(audit, undoTargets);
      return jsonResponse(visibilityResponseSchema.parse({
        state: next,
        auditEntry: audit,
        undoTargets,
        serverTime: createdAt,
      }));
    }

    return null;
  };

export const createHudModule = (broadcastTags: readonly SocketTag[]): {
  handle: ModuleHandler;
  history: ModuleHistory;
  state: ModuleState;
} => {
  const state = createHudState(broadcastTags);
  return {
    handle: createHudHttpHandler(state),
    history: createHudHistory(state),
    state,
  };
};
