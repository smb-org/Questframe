import { describe, expect, it, vi } from "vitest";

import {
  completeTwitchAuthentication,
  lookupTwitchUser,
  validateTwitchEditor,
} from "../../../src/worker/twitch";
import type { TwitchAuthError } from "../../../src/worker/twitch";

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

describe("Twitch OAuth boundary", () => {
  it("exchanges a PKCE code and accepts the exact broadcaster ID", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          scope: ["user:read:moderated_channels"],
          token_type: "bearer",
        }),
      )
      .mockResolvedValueOnce(
        json({ client_id: "client", login: "broadcaster", scopes: [], user_id: "12345678901234567890", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        json({ data: [{ id: "12345678901234567890", login: "broadcaster", display_name: "Broadcaster", profile_image_url: "https://example.test/broadcaster.png" }] }),
      );

    const result = await completeTwitchAuthentication(
      {
        clientId: "client",
        clientSecret: "secret",
        broadcasterId: "12345678901234567890",
        redirectUri: "https://hud.example/auth/twitch/callback",
      },
      "oauth-code",
      "pkce-verifier",
      fetcher,
      1_000,
    );

    expect(result.user.id).toBe("12345678901234567890");
    expect(result.user.displayName).toBe("Broadcaster");
    expect(result.tokenExpiresAt).toBe("1970-01-01T01:00:01.000Z");
    expect(fetcher).toHaveBeenCalledTimes(3);
    // Editor und Broadcaster sind hier dieselbe Person: das Broadcaster-Profil
    // wird ohne zusätzlichen Request aus dem eigenen Profil abgeleitet.
    expect(result.user.broadcaster).toEqual({
      id: "12345678901234567890",
      login: "broadcaster",
      displayName: "Broadcaster",
      profileImageUrl: "https://example.test/broadcaster.png",
    });
    expect(fetcher.mock.calls[2]?.[0]).toBe(
      "https://api.twitch.tv/helix/users?id=12345678901234567890",
    );
  });

  it("accepts a moderator only when Get Moderated Channels includes the configured broadcaster", async () => {
    let usersUrl = "";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ client_id: "client", login: "moderator", scopes: [], user_id: "99999999999999999999", expires_in: 3600 }),
      )
      .mockImplementationOnce((input) => {
        usersUrl = new Request(input).url;
        return Promise.resolve(
          json({
            data: [
              { id: "99999999999999999999", login: "moderator", display_name: "Moderator", profile_image_url: "https://example.test/moderator.png" },
              { id: "12345678901234567890", login: "broadcaster", display_name: "Broadcaster", profile_image_url: "https://example.test/broadcaster.png" },
            ],
          }),
        );
      })
      .mockResolvedValueOnce(
        json({ data: [{ broadcaster_id: "12345678901234567890", broadcaster_login: "broadcaster", broadcaster_name: "Broadcaster" }], pagination: {} }),
      );

    const result = await validateTwitchEditor(
      { clientId: "client", broadcasterId: "12345678901234567890" },
      "access",
      fetcher,
    );
    expect(result.displayName).toBe("Moderator");
    expect(result.id).toBe("99999999999999999999");
    // Editor- und Broadcaster-ID werden in einer einzigen Helix-Anfrage abgefragt.
    expect(usersUrl).toBe(
      "https://api.twitch.tv/helix/users?id=99999999999999999999&id=12345678901234567890",
    );
    expect(result.broadcaster).toEqual({
      id: "12345678901234567890",
      login: "broadcaster",
      displayName: "Broadcaster",
      profileImageUrl: "https://example.test/broadcaster.png",
    });
  });

  it("still returns the eligible editor when Twitch omits the broadcaster from the combined users lookup", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ client_id: "client", login: "moderator", scopes: [], user_id: "99999999999999999999", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        json({ data: [{ id: "99999999999999999999", login: "moderator", display_name: "Moderator", profile_image_url: "https://example.test/moderator.png" }] }),
      )
      .mockResolvedValueOnce(
        json({ data: [{ broadcaster_id: "12345678901234567890", broadcaster_login: "broadcaster", broadcaster_name: "Broadcaster" }], pagination: {} }),
      );

    const result = await validateTwitchEditor(
      { clientId: "client", broadcasterId: "12345678901234567890" },
      "access",
      fetcher,
    );
    expect(result.id).toBe("99999999999999999999");
    expect(result.broadcaster).toBeNull();
  });

  it("follows moderated-channel pagination until it finds the configured broadcaster", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ client_id: "client", login: "busy_mod", scopes: [], user_id: "77777777777777777777", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        json({ data: [{ id: "77777777777777777777", login: "busy_mod", display_name: "BusyMod", profile_image_url: "https://example.test/busy.png" }] }),
      )
      .mockResolvedValueOnce(
        json({ data: [{ broadcaster_id: "111", broadcaster_login: "other", broadcaster_name: "Other" }], pagination: { cursor: "next-page" } }),
      )
      .mockResolvedValueOnce(
        json({ data: [{ broadcaster_id: "12345678901234567890", broadcaster_login: "broadcaster", broadcaster_name: "Broadcaster" }], pagination: {} }),
      );

    await expect(validateTwitchEditor(
      { clientId: "client", broadcasterId: "12345678901234567890" },
      "access",
      fetcher,
    )).resolves.toMatchObject({ displayName: "BusyMod" });
    expect(fetcher.mock.calls[3]?.[0]).toBe(
      "https://api.twitch.tv/helix/moderation/channels?user_id=77777777777777777777&first=100&after=next-page",
    );
  });

  it("rejects ineligible users and never coerces IDs to numbers", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ client_id: "client", login: "other", scopes: [], user_id: "90071992547409931234", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        json({ data: [{ id: "90071992547409931234", login: "other", display_name: "Other", profile_image_url: "https://example.test/o.png" }] }),
      )
      .mockResolvedValueOnce(json({ data: [], pagination: {} }));

    await expect(
      validateTwitchEditor(
        { clientId: "client", broadcasterId: "12345678901234567890" },
        "access",
        fetcher,
      ),
    ).rejects.toMatchObject({
      code: "role_ineligible",
      message: "Nur der Broadcaster und aktuelle Twitch-Moderator:innen haben Zugriff.",
    } satisfies Partial<TwitchAuthError>);
  });

  it("maps upstream failures to stable errors without returning Twitch payloads", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ message: "raw secret detail" }, 429));
    await expect(
      validateTwitchEditor(
        { clientId: "client", broadcasterId: "12345678901234567890" },
        "access",
        fetcher,
      ),
    ).rejects.toMatchObject({ code: "upstream_unavailable" } satisfies Partial<TwitchAuthError>);
  });

  it("looks up canonical guest identity by normalized login", async () => {
    let requestedUrl = "";
    let clientId = "";
    const fetcher: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      requestedUrl = request.url;
      clientId = request.headers.get("client-id") ?? "";
      return Promise.resolve(
        json({
          data: [
            {
              id: "88888888888888888888",
              login: "gast_tv",
              display_name: "GastTV",
              profile_image_url: "https://example.test/gast.png",
            },
          ],
        }),
      );
    };
    await expect(
      lookupTwitchUser({ clientId: "client" }, "access", "Gast_TV", fetcher),
    ).resolves.toEqual({
      id: "88888888888888888888",
      login: "gast_tv",
      displayName: "GastTV",
      profileImageUrl: "https://example.test/gast.png",
    });
    expect(requestedUrl).toBe("https://api.twitch.tv/helix/users?login=gast_tv");
    expect(clientId).toBe("client");
  });

  it("classifies an exact Twitch lookup with no user as not found", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({ data: [] }),
    );

    await expect(
      lookupTwitchUser({ clientId: "client" }, "access", "unknown_login", fetcher),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "Twitch-Benutzer wurde nicht gefunden.",
    } satisfies Partial<TwitchAuthError>);
  });
});
