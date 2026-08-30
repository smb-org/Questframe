import { z } from "zod";

const twitchIdSchema = z.string().regex(/^\d+$/);

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(2_048),
  refresh_token: z.string().min(1).max(2_048),
  expires_in: z.number().int().positive(),
  scope: z.array(z.string()),
  token_type: z.string(),
});

const validateResponseSchema = z.object({
  client_id: z.string().min(1),
  login: z.string().min(1),
  scopes: z.array(z.string()),
  user_id: twitchIdSchema,
  expires_in: z.number().int().positive(),
});

const userSchema = z.object({
  id: twitchIdSchema,
  login: z.string().regex(/^[A-Za-z0-9_]{1,25}$/),
  display_name: z.string().min(1).max(32),
  profile_image_url: z.url(),
});

const usersResponseSchema = z.object({ data: z.array(userSchema).max(2) });

const moderatedChannelsResponseSchema = z.object({
  data: z.array(
    z.object({
      broadcaster_id: twitchIdSchema,
      broadcaster_login: z.string(),
      broadcaster_name: z.string(),
    }),
  ),
  pagination: z.object({ cursor: z.string().optional() }),
});

export type TwitchAuthErrorCode =
  | "role_ineligible"
  | "upstream_unavailable"
  | "not_found"
  | "invalid_response";

export class TwitchAuthError extends Error {
  readonly code: TwitchAuthErrorCode;

  constructor(code: TwitchAuthErrorCode, message: string) {
    super(message);
    this.name = "TwitchAuthError";
    this.code = code;
  }
}

type TwitchPublicConfig = {
  clientId: string;
  broadcasterId: string;
};

type TwitchOAuthConfig = TwitchPublicConfig & {
  clientSecret: string;
  redirectUri: string;
};

export type TwitchEditor = {
  id: string;
  login: string;
  displayName: string;
  profileImageUrl: string;
};

export type TwitchEditorWithBroadcaster = TwitchEditor & {
  // null nur, wenn Twitch das Broadcaster-Profil ausnahmsweise nicht mitliefert
  // (z.B. gelöschter Account); der Login selbst darf daran nicht scheitern.
  broadcaster: TwitchEditor | null;
};

const toTwitchEditor = (user: z.infer<typeof userSchema>): TwitchEditor => ({
  id: user.id,
  login: user.login,
  displayName: user.display_name,
  profileImageUrl: user.profile_image_url,
});

const requestJson = async (
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch {
    throw new TwitchAuthError("upstream_unavailable", "Twitch ist derzeit nicht erreichbar.");
  }
  if (!response.ok) {
    throw new TwitchAuthError("upstream_unavailable", "Twitch hat die Anfrage abgelehnt.");
  }
  try {
    return await response.json<unknown>();
  } catch {
    throw new TwitchAuthError("invalid_response", "Twitch-Antwort war ungültig.");
  }
};

const parseBoundary = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new TwitchAuthError("invalid_response", "Twitch-Antwort hatte ein unbekanntes Format.");
  }
  return result.data;
};

const moderatesBroadcaster = async (
  config: TwitchPublicConfig,
  userId: string,
  authHeaders: Record<string, string>,
  fetcher: typeof fetch,
): Promise<boolean> => {
  let after: string | undefined;
  const seenCursors = new Set<string>();
  // Leaves headroom below the Workers Free subrequest limit for token,
  // user, Durable Object and confirmation calls while covering 4,000 channels.
  for (let page = 0; page < 40; page += 1) {
    const parameters = new URLSearchParams({ user_id: userId, first: "100" });
    if (after !== undefined) parameters.set("after", after);
    const channels = parseBoundary(
      moderatedChannelsResponseSchema,
      await requestJson(
        `https://api.twitch.tv/helix/moderation/channels?${parameters.toString()}`,
        { headers: authHeaders },
        fetcher,
      ),
    );
    if (channels.data.some((channel) => channel.broadcaster_id === config.broadcasterId)) {
      return true;
    }
    const cursor = channels.pagination.cursor;
    if (cursor === undefined || seenCursors.has(cursor)) return false;
    seenCursors.add(cursor);
    after = cursor;
  }
  throw new TwitchAuthError("upstream_unavailable", "Twitch-Moderatorenliste ist ungewöhnlich groß.");
};

export const validateTwitchEditor = async (
  config: TwitchPublicConfig,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<TwitchEditorWithBroadcaster> => {
  const authHeaders = {
    authorization: `Bearer ${accessToken}`,
    "client-id": config.clientId,
  };
  const validation = parseBoundary(
    validateResponseSchema,
    await requestJson(
      "https://id.twitch.tv/oauth2/validate",
      { headers: { authorization: `OAuth ${accessToken}` } },
      fetcher,
    ),
  );
  if (validation.client_id !== config.clientId) {
    throw new TwitchAuthError("invalid_response", "Twitch-Token gehört zu einer anderen App.");
  }
  // Helix erlaubt mehrere `id`-Parameter in einer Anfrage: eigenes Profil und
  // Broadcaster-Profil werden hier gemeinsam abgefragt statt in zwei Requests.
  const editorIsBroadcaster = validation.user_id === config.broadcasterId;
  const idParameters = new URLSearchParams();
  idParameters.append("id", validation.user_id);
  if (!editorIsBroadcaster) idParameters.append("id", config.broadcasterId);
  const users = parseBoundary(
    usersResponseSchema,
    await requestJson(
      `https://api.twitch.tv/helix/users?${idParameters.toString()}`,
      { headers: authHeaders },
      fetcher,
    ),
  );
  const user = users.data.find((entry) => entry.id === validation.user_id);
  if (user === undefined) {
    throw new TwitchAuthError("invalid_response", "Twitch-Benutzer konnte nicht bestätigt werden.");
  }
  if (!editorIsBroadcaster) {
    const eligible = await moderatesBroadcaster(config, user.id, authHeaders, fetcher);
    if (!eligible) {
      throw new TwitchAuthError(
        "role_ineligible",
        "Nur der Broadcaster und aktuelle Twitch-Moderator:innen haben Zugriff.",
      );
    }
  }
  const editor = toTwitchEditor(user);
  const broadcasterUser = editorIsBroadcaster
    ? user
    : users.data.find((entry) => entry.id === config.broadcasterId);
  return {
    ...editor,
    broadcaster: broadcasterUser === undefined ? null : toTwitchEditor(broadcasterUser),
  };
};

export const lookupTwitchUser = async (
  config: { clientId: string },
  accessToken: string,
  loginInput: string,
  fetcher: typeof fetch = fetch,
): Promise<TwitchEditor> => {
  const login = loginInput.normalize("NFC").trim().toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(login)) {
    throw new TwitchAuthError("invalid_response", "Twitch-Login ist ungültig.");
  }
  const users = parseBoundary(
    usersResponseSchema,
    await requestJson(
      `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "client-id": config.clientId,
        },
      },
      fetcher,
    ),
  );
  const user = users.data[0];
  if (user === undefined) {
    throw new TwitchAuthError("not_found", "Twitch-Benutzer wurde nicht gefunden.");
  }
  return {
    id: user.id,
    login: user.login,
    displayName: user.display_name,
    profileImageUrl: user.profile_image_url,
  };
};

const requestOAuthToken = async (
  config: TwitchOAuthConfig,
  parameters: Record<string, string>,
  fetcher: typeof fetch,
): Promise<z.infer<typeof tokenResponseSchema>> => {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    ...parameters,
  });
  return parseBoundary(
    tokenResponseSchema,
    await requestJson(
      "https://id.twitch.tv/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
      fetcher,
    ),
  );
};

export const completeTwitchAuthentication = async (
  config: TwitchOAuthConfig,
  code: string,
  codeVerifier: string,
  fetcher: typeof fetch = fetch,
  nowMilliseconds = Date.now(),
): Promise<{
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: string;
  user: TwitchEditorWithBroadcaster;
}> => {
  const tokens = await requestOAuthToken(
    config,
    {
      code,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier,
    },
    fetcher,
  );
  const user = await validateTwitchEditor(config, tokens.access_token, fetcher);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: new Date(nowMilliseconds + tokens.expires_in * 1_000).toISOString(),
    user,
  };
};

export const refreshTwitchAuthentication = async (
  config: TwitchOAuthConfig,
  refreshToken: string,
  fetcher: typeof fetch = fetch,
  nowMilliseconds = Date.now(),
): Promise<{
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: string;
  user: TwitchEditorWithBroadcaster;
}> => {
  const tokens = await requestOAuthToken(
    config,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    fetcher,
  );
  const user = await validateTwitchEditor(config, tokens.access_token, fetcher);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: new Date(nowMilliseconds + tokens.expires_in * 1_000).toISOString(),
    user,
  };
};
