import { z } from "zod";

import { getChannelStub } from "./channel";
import { sha256Hex, randomToken } from "../channel/crypto";
import {
  decryptToken,
  encryptToken,
  parseKeyring,
  signOpaqueCookie,
  signValue,
  tokenEnvelopeSchema,
  verifyOpaqueCookie,
  verifySignedValue,
} from "../channel/auth/crypto";
import { errorResponse, jsonResponse } from "./http";
import { getMissingBindings, type AppEnv } from "./env";
import { OVERLAY_SOCKET_PROTOCOL } from "../shared/contracts/protocol";
import {
  completeTwitchAuthentication,
  refreshTwitchAuthentication,
  lookupTwitchUser,
  TwitchAuthError,
  validateTwitchEditor,
} from "./twitch";

export { ChannelObject } from "../channel/channel-object";

const SESSION_COOKIE = "irl-stream-hud-session";
const OAUTH_COOKIE = "irl-stream-hud-oauth-binding";
const LOCAL_COOKIE_KEYRING = JSON.stringify({
  active: { id: "local-cookie", key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
});
const LOCAL_ENCRYPTION_KEYRING = JSON.stringify({
  active: { id: "local-token", key: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
});

const getCookie = (request: Request, name: string): string | null => {
  const cookie = request.headers.get("cookie");
  if (cookie === null) return null;
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
};

const runtimeKeyring = (value: string | undefined, env: AppEnv, localFallback: string) => {
  if (env.APP_ENV === "local") {
    try {
      const keyring = parseKeyring(value ?? "");
      if (!keyring.active.key.startsWith("replace-")) return keyring;
    } catch {
      // Keep local development usable with the intentionally invalid example values.
    }
    return parseKeyring(localFallback);
  }
  return parseKeyring(value ?? "");
};

const cookieKeyring = (env: AppEnv) =>
  runtimeKeyring(env.SESSION_COOKIE_KEYS, env, LOCAL_COOKIE_KEYRING);

const encryptionKeyring = (env: AppEnv) =>
  runtimeKeyring(env.SESSION_ENCRYPTION_KEYS, env, LOCAL_ENCRYPTION_KEYRING);

const resolveSession = async (
  request: Request,
  env: AppEnv,
): Promise<{ sessionId: string; sessionHash: string } | null> => {
  const rawCookie = getCookie(request, SESSION_COOKIE);
  if (rawCookie === null) return null;
  let sessionId: string | null;
  try {
    sessionId = await verifyOpaqueCookie(rawCookie, cookieKeyring(env));
  } catch {
    return null;
  }
  if (sessionId === null) return null;
  return { sessionId, sessionHash: await sha256Hex(sessionId) };
};

const sessionHeaders = async (request: Request, env: AppEnv): Promise<Headers> => {
  const headers = new Headers();
  const session = await resolveSession(request, env);
  if (session !== null) headers.set("x-session-hash", session.sessionHash);
  const tab = request.headers.get("x-editor-tab");
  const csrf = request.headers.get("x-csrf-token");
  const upgrade = request.headers.get("upgrade");
  if (tab !== null) headers.set("x-editor-tab", tab);
  if (csrf !== null) headers.set("x-csrf-token", csrf);
  if (upgrade !== null) headers.set("upgrade", upgrade);
  return headers;
};

const proxyToChannel = async (
  request: Request,
  env: AppEnv,
  pathname: string,
  extraHeaders?: HeadersInit,
): Promise<Response> => {
  const headers = await sessionHeaders(request, env);
  for (const [name, value] of new Headers(extraHeaders)) headers.set(name, value);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
  const contentType = request.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  const init: RequestInit = { method: request.method, headers };
  if (body !== undefined) init.body = body;
  return getChannelStub(env).fetch(
    new Request(`https://channel.internal${pathname}`, init),
  );
};

const requireSameOriginMutation = (request: Request, env: AppEnv): Response | null =>
  request.headers.get("origin") === env.PUBLIC_ORIGIN
    ? null
    : errorResponse(403, "forbidden", "Ungültiger Ursprung.");

// Browser senden bei same-origin GET keinen Origin-Header; Sec-Fetch-Site ist aus JS nicht setzbar.
const requireSameOriginRead = (request: Request, env: AppEnv): Response | null => {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const allowed =
    origin !== null ? origin === env.PUBLIC_ORIGIN : site === "same-origin" || site === "none";
  return allowed ? null : errorResponse(403, "forbidden", "Ungültiger Ursprung.");
};

const handleDevAuth = async (env: AppEnv): Promise<Response> => {
  if (env.APP_ENV !== "local") return errorResponse(404, "not_found", "Route nicht gefunden.");
  const sessionId = randomToken(32);
  try {
    await getChannelStub(env).fetch("https://channel.internal/internal/twitch/cache", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user: {
          id: env.BROADCASTER_ID,
          login: "lokaler_broadcaster",
          displayName: "Lokaler Broadcaster",
          profileImageUrl: "https://static-cdn.jtvnw.net/user-default-pictures-uv/lokaler-broadcaster.png",
        },
      }),
    });
  } catch {
    // Best effort: der Admin-Header fällt sonst auf capsule.name zurück.
  }
  const response = await getChannelStub(env).fetch("https://channel.internal/internal/session/dev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionHash: await sha256Hex(sessionId),
      twitchUserId: env.BROADCASTER_ID,
      displayName: "Lokaler Broadcaster",
    }),
  });
  if (!response.ok) return response;
  const signedSession = await signOpaqueCookie(sessionId, cookieKeyring(env));
  const headers = new Headers({
    location: "/admin",
    "cache-control": "no-store",
  });
  headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${signedSession}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
  );
  return new Response(null, { status: 302, headers });
};

const sha256Base64Url = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(new TextEncoder().encode(value)).buffer,
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const secureCookieSuffix = (env: AppEnv): string =>
  env.PUBLIC_ORIGIN.startsWith("https://") ? "; Secure" : "";

const authFailureRedirect = (env: AppEnv, code: string): Response =>
  Response.redirect(`${env.PUBLIC_ORIGIN}/login?error=${encodeURIComponent(code)}`, 302);

const handleTwitchStart = async (env: AppEnv): Promise<Response> => {
  if (getMissingBindings(env).length > 0) {
    return authFailureRedirect(env, "misconfigured");
  }
  const nonce = randomToken(32);
  const binding = randomToken(32);
  const pkceVerifier = randomToken(32);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
  const nonceResponse = await getChannelStub(env).fetch("https://channel.internal/internal/oauth/nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      nonceHash: await sha256Hex(nonce),
      bindingHash: await sha256Hex(binding),
      pkceVerifier,
      expiresAt,
    }),
  });
  if (!nonceResponse.ok) return authFailureRedirect(env, "oauth_start_failed");
  const state = await signValue("oauth-state", nonce, cookieKeyring(env));
  const authorize = new URL("https://id.twitch.tv/oauth2/authorize");
  authorize.searchParams.set("client_id", env.TWITCH_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${env.PUBLIC_ORIGIN}/auth/twitch/callback`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "user:read:moderated_channels");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", await sha256Base64Url(pkceVerifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  const headers = new Headers({ location: authorize.toString(), "cache-control": "no-store" });
  headers.append(
    "set-cookie",
    `${OAUTH_COOKIE}=${binding}; Path=/auth/twitch/callback; HttpOnly; SameSite=Lax; Max-Age=600${secureCookieSuffix(env)}`,
  );
  return new Response(null, { status: 302, headers });
};

const handleTwitchCallback = async (request: Request, env: AppEnv): Promise<Response> => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const signedState = url.searchParams.get("state");
  const binding = getCookie(request, OAUTH_COOKIE);
  if (code === null || signedState === null || binding === null || env.TWITCH_CLIENT_SECRET === undefined) {
    return authFailureRedirect(env, "oauth_invalid");
  }
  try {
    const nonce = await verifySignedValue("oauth-state", signedState, cookieKeyring(env));
    if (nonce === null) return authFailureRedirect(env, "oauth_invalid");
    const consume = await getChannelStub(env).fetch("https://channel.internal/internal/oauth/consume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonceHash: await sha256Hex(nonce),
        bindingHash: await sha256Hex(binding),
      }),
    });
    if (!consume.ok) return authFailureRedirect(env, "oauth_expired");
    const consumed = z
      .strictObject({ pkceVerifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .parse(await consume.json());
    const authentication = await completeTwitchAuthentication(
      {
        clientId: env.TWITCH_CLIENT_ID,
        clientSecret: env.TWITCH_CLIENT_SECRET,
        broadcasterId: env.BROADCASTER_ID,
        redirectUri: `${env.PUBLIC_ORIGIN}/auth/twitch/callback`,
      },
      code,
      consumed.pkceVerifier,
    );
    const sessionId = randomToken(32);
    const keyring = encryptionKeyring(env);
    const accessEnvelope = await encryptToken(authentication.accessToken, keyring, {
      broadcasterId: env.BROADCASTER_ID,
      sessionId,
      twitchUserId: authentication.user.id,
      tokenKind: "access",
    });
    const refreshEnvelope = await encryptToken(authentication.refreshToken, keyring, {
      broadcasterId: env.BROADCASTER_ID,
      sessionId,
      twitchUserId: authentication.user.id,
      tokenKind: "refresh",
    });
    const createSession = await getChannelStub(env).fetch(
      "https://channel.internal/internal/session/oauth",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionHash: await sha256Hex(sessionId),
          twitchUserId: authentication.user.id,
          displayName: authentication.user.displayName,
          accessTokenEnvelope: JSON.stringify(accessEnvelope),
          refreshTokenEnvelope: JSON.stringify(refreshEnvelope),
          tokenExpiresAt: authentication.tokenExpiresAt,
        }),
      },
    );
    if (!createSession.ok) return authFailureRedirect(env, "session_failed");
    if (authentication.user.broadcaster !== null) {
      try {
        await getChannelStub(env).fetch("https://channel.internal/internal/twitch/cache", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ user: authentication.user.broadcaster }),
        });
      } catch {
        // Best effort: der Admin-Header fällt sonst auf capsule.name zurück.
      }
    }
    const signedSession = await signOpaqueCookie(sessionId, cookieKeyring(env));
    const headers = new Headers({ location: "/admin", "cache-control": "no-store" });
    headers.append(
      "set-cookie",
      `${SESSION_COOKIE}=${signedSession}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secureCookieSuffix(env)}`,
    );
    headers.append(
      "set-cookie",
      `${OAUTH_COOKIE}=; Path=/auth/twitch/callback; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieSuffix(env)}`,
    );
    return new Response(null, { status: 302, headers });
  } catch (error) {
    const codeName =
      error instanceof TwitchAuthError && error.code === "role_ineligible"
        ? "not_editor"
        : "twitch_unavailable";
    return authFailureRedirect(env, codeName);
  }
};

const authMaterialSchema = z.strictObject({
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
  twitchUserId: z.string().regex(/^\d+$/),
  displayName: z.string().min(1).max(32),
  generation: z.number().int().min(1),
  accessTokenEnvelope: tokenEnvelopeSchema,
  refreshTokenEnvelope: tokenEnvelopeSchema,
  tokenExpiresAt: z.iso.datetime({ offset: true }),
});

const handleRevalidation = async (request: Request, env: AppEnv): Promise<Response> => {
  const session = await resolveSession(request, env);
  const tabId = request.headers.get("x-editor-tab");
  if (session === null || tabId === null) {
    return errorResponse(401, "unauthorized", "Sitzung abgelaufen.");
  }
  const materialResponse = await getChannelStub(env).fetch(
    "https://channel.internal/internal/auth/material",
    { headers: { "x-session-hash": session.sessionHash } },
  );
  if (!materialResponse.ok) return materialResponse;
  try {
    const material = authMaterialSchema.parse(await materialResponse.json());
    const keyring = encryptionKeyring(env);
    const accessToken = await decryptToken(material.accessTokenEnvelope, keyring, {
      broadcasterId: env.BROADCASTER_ID,
      sessionId: session.sessionId,
      twitchUserId: material.twitchUserId,
      tokenKind: "access",
    });
    const refreshToken = await decryptToken(material.refreshTokenEnvelope, keyring, {
      broadcasterId: env.BROADCASTER_ID,
      sessionId: session.sessionId,
      twitchUserId: material.twitchUserId,
      tokenKind: "refresh",
    });
    if (env.TWITCH_CLIENT_SECRET === undefined) {
      return errorResponse(503, "misconfigured", "Twitch ist nicht konfiguriert.");
    }
    const twitchConfig = {
      clientId: env.TWITCH_CLIENT_ID,
      clientSecret: env.TWITCH_CLIENT_SECRET,
      broadcasterId: env.BROADCASTER_ID,
      redirectUri: `${env.PUBLIC_ORIGIN}/auth/twitch/callback`,
    };
    let nextAccess = accessToken;
    let nextRefresh = refreshToken;
    let nextExpiresAt = material.tokenExpiresAt;
    let editor;
    if (Date.parse(material.tokenExpiresAt) <= Date.now() + 5 * 60 * 1_000) {
      const refreshed = await refreshTwitchAuthentication(twitchConfig, refreshToken);
      nextAccess = refreshed.accessToken;
      nextRefresh = refreshed.refreshToken;
      nextExpiresAt = refreshed.tokenExpiresAt;
      editor = refreshed.user;
    } else {
      editor = await validateTwitchEditor(twitchConfig, accessToken);
    }
    if (editor.broadcaster !== null) {
      try {
        await getChannelStub(env).fetch("https://channel.internal/internal/twitch/cache", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ user: editor.broadcaster }),
        });
      } catch {
        // Best effort: der Admin-Header fällt sonst auf capsule.name zurück.
      }
    }
    const accessEnvelope = await encryptToken(nextAccess, keyring, {
      broadcasterId: env.BROADCASTER_ID,
      sessionId: session.sessionId,
      twitchUserId: editor.id,
      tokenKind: "access",
    });
    const refreshEnvelope = await encryptToken(nextRefresh, keyring, {
      broadcasterId: env.BROADCASTER_ID,
      sessionId: session.sessionId,
      twitchUserId: editor.id,
      tokenKind: "refresh",
    });
    return await getChannelStub(env).fetch("https://channel.internal/internal/auth/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionHash: session.sessionHash,
        generation: material.generation,
        twitchUserId: editor.id,
        displayName: editor.displayName,
        accessTokenEnvelope: JSON.stringify(accessEnvelope),
        refreshTokenEnvelope: JSON.stringify(refreshEnvelope),
        tokenExpiresAt: nextExpiresAt,
        tabId,
      }),
    });
  } catch (error) {
    await getChannelStub(env).fetch("https://channel.internal/internal/session/logout", {
      method: "POST",
      headers: { "x-session-hash": session.sessionHash },
    });
    const code = error instanceof TwitchAuthError && error.code === "role_ineligible"
      ? "role_ineligible"
      : "upstream_unavailable";
    return errorResponse(403, code, "Twitch-Berechtigung konnte nicht bestätigt werden.");
  }
};

const handleTwitchLookup = async (request: Request, env: AppEnv): Promise<Response> => {
  const session = await resolveSession(request, env);
  const login = new URL(request.url).searchParams.get("login");
  if (session === null) return errorResponse(401, "unauthorized", "Sitzung abgelaufen.");
  if (login === null || !/^[A-Za-z0-9_]{1,25}$/.test(login)) {
    return errorResponse(422, "validation_failed", "Twitch-Login ist ungültig.");
  }
  const materialResponse = await getChannelStub(env).fetch(
    "https://channel.internal/internal/auth/material",
    { headers: { "x-session-hash": session.sessionHash } },
  );
  if (!materialResponse.ok) return materialResponse;
  try {
    const material = authMaterialSchema.parse(await materialResponse.json());
    if (Date.parse(material.tokenExpiresAt) <= Date.now()) {
      return errorResponse(403, "unauthorized", "Twitch-Sitzung muss neu geprüft werden.");
    }
    const accessToken = await decryptToken(
      material.accessTokenEnvelope,
      encryptionKeyring(env),
      {
        broadcasterId: env.BROADCASTER_ID,
        sessionId: session.sessionId,
        twitchUserId: material.twitchUserId,
        tokenKind: "access",
      },
    );
    const user = await lookupTwitchUser({ clientId: env.TWITCH_CLIENT_ID }, accessToken, login);
    return await getChannelStub(env).fetch("https://channel.internal/internal/twitch/cache", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user }),
    });
  } catch (error) {
    if (error instanceof TwitchAuthError && error.code === "not_found") {
      return errorResponse(404, "not_found", "Kein Twitch-Konto mit diesem Login.");
    }
    return errorResponse(503, "upstream_unavailable", "Twitch-Gast konnte nicht geladen werden.");
  }
};

const worker = {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      const missingBindings = getMissingBindings(env);
      return jsonResponse(
        {
          status: missingBindings.length === 0 ? "ok" : "misconfigured",
          schemaVersion: 1,
          missingBindings,
        },
        missingBindings.length === 0 ? 200 : 503,
      );
    }

    if (request.method === "GET" && url.pathname === "/auth/dev") {
      return handleDevAuth(env);
    }

    if (request.method === "GET" && url.pathname === "/auth/twitch/start") {
      return handleTwitchStart(env);
    }

    if (request.method === "GET" && url.pathname === "/auth/twitch/callback") {
      return handleTwitchCallback(request, env);
    }

    if (request.method === "POST" && url.pathname === "/auth/logout") {
      const originError = requireSameOriginMutation(request, env);
      if (originError !== null) return originError;
      const response = await proxyToChannel(request, env, "/internal/session/logout");
      const headers = new Headers(response.headers);
      headers.append(
        "set-cookie",
        `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      );
      return new Response(response.body, { status: response.status, headers });
    }

    if (request.method === "GET" && url.pathname === "/api/editor/bootstrap") {
      if (env.APP_ENV !== "local") {
        const revalidation = await handleRevalidation(request, env);
        if (!revalidation.ok) return revalidation;
      }
      return proxyToChannel(request, env, "/editor/bootstrap");
    }

    if (request.method === "POST" && url.pathname === "/api/auth/revalidate") {
      const originError = requireSameOriginMutation(request, env);
      if (originError !== null) return originError;
      return handleRevalidation(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/twitch/users") {
      const originError = requireSameOriginRead(request, env);
      if (originError !== null) return originError;
      return handleTwitchLookup(request, env);
    }

    const challengeRoutes: Record<string, { pathname: string; protection: "read" | "editor" | "command" }> = {
      "GET /api/challenges": { pathname: "/challenges", protection: "read" },
      "POST /api/challenges/commands": { pathname: "/challenges/commands", protection: "command" },
      "PUT /api/challenges/board": { pathname: "/challenges/board", protection: "editor" },
      "PUT /api/challenges/settings": { pathname: "/challenges/settings", protection: "editor" },
    };
    const challengeRoute = challengeRoutes[`${request.method} ${url.pathname}`];
    if (challengeRoute !== undefined) {
      if (challengeRoute.protection === "read") {
        const originError = requireSameOriginRead(request, env);
        if (originError !== null) return originError;
      } else {
        // Session-Kommandos folgen derselben Herkunftsprüfung wie jede Editor-Mutation.
        // Ein späterer Bearer-Dock-Weg braucht wegen fehlender Cookie-Credentials kein
        // CSRF-Gate; dort greifen stattdessen Token-Prüfung und DOCK_TOKEN_LIMITER.
        const originError = requireSameOriginMutation(request, env);
        if (originError !== null) return originError;
      }
      return proxyToChannel(request, env, challengeRoute.pathname);
    }

    const mutations: Record<string, string> = {
      "/api/state": "/state",
      "/api/state/undo": "/state/undo",
      "/api/overlay-visibility": "/overlay-visibility",
      "/api/overlay-token": "/overlay-token",
      "/api/overlay-token/rotate": "/overlay-token/rotate",
      "/api/media": "/media",
      "/api/media/leases/renew": "/media/leases/renew",
    };
    const mutationPath = mutations[url.pathname];
    if (mutationPath !== undefined) {
      const originError = requireSameOriginMutation(request, env);
      if (originError !== null) return originError;
      return proxyToChannel(request, env, mutationPath);
    }

    if (request.method === "GET" && url.pathname === "/ws/editor") {
      const tabId = url.searchParams.get("tab");
      if (tabId === null) return errorResponse(400, "bad_request", "Editor-Tab fehlt.");
      return proxyToChannel(request, env, "/ws/editor", { "x-editor-tab": tabId });
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/media/")) {
      const authorization = request.headers.get("authorization");
      const extra = new Headers();
      if (authorization?.startsWith("Bearer ") === true) {
        extra.set("x-overlay-token", authorization.slice("Bearer ".length));
      }
      return proxyToChannel(
        request,
        env,
        `/media/${url.pathname.slice("/api/media/".length)}`,
        extra,
      );
    }

    if (request.method === "GET" && url.pathname === "/ws/overlay") {
      const protocolHeader = request.headers.get("sec-websocket-protocol");
      const protocolEntries = protocolHeader?.split(",").map((entry) => entry.trim()) ?? [];
      const [protocolName, token] = protocolEntries;
      if (
        protocolEntries.length !== 2 ||
        protocolName !== OVERLAY_SOCKET_PROTOCOL ||
        token === undefined ||
        !/^[A-Za-z0-9_-]{43}$/.test(token)
      ) {
        return errorResponse(403, "token_invalid", "OBS-Token ungültig.");
      }
      const capsuleLimit = await env.OVERLAY_CAPSULE_LIMITER.limit({ key: env.CAPSULE_ID });
      const tokenLimit = await env.OVERLAY_TOKEN_LIMITER.limit({
        key: (await sha256Hex(token)).slice(0, 32),
      });
      if (!capsuleLimit.success || !tokenLimit.success) {
        return errorResponse(429, "rate_limited", "Zu viele Overlay-Verbindungen.");
      }
      return proxyToChannel(request, env, "/ws/overlay", { "x-overlay-token": token });
    }

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/ws/")) {
      return errorResponse(404, "not_found", "Route nicht gefunden.");
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<AppEnv>;

export default worker;
