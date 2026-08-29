import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// This file runs ONLY under vitest.worker-configured.config.ts, the second
// Worker testing environment where every binding is a real, schema-valid
// value (APP_ENV: "staging"). Unlike vitest.worker.config.ts (whose
// placeholder bindings make the app permanently believe it is misconfigured,
// see tests/worker/channel.test.ts and tests/worker/gateway.test.ts), this
// environment lets the app conclude it is CORRECTLY configured, so the
// success paths gated behind `getMissingBindings().length === 0` --
// `/healthz` 200 and the full `/auth/twitch/start` redirect -- are actually
// exercised.

const fetchWorker = (input: string, init?: RequestInit): Promise<Response> =>
  exports.default.fetch(new Request(input, init));

describe("worker in a correctly configured (staging) environment", () => {
  it("reports a healthy /healthz with no missing bindings", async () => {
    const response = await fetchWorker("http://localhost/healthz");
    const body = await response.json<{
      status: string;
      schemaVersion: number;
      missingBindings: string[];
    }>();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "ok",
      schemaVersion: 1,
      missingBindings: [],
    });
  });

  it("never leaks a bound secret value through /healthz", async () => {
    const response = await fetchWorker("http://localhost/healthz");
    const serialized = JSON.stringify(await response.json());

    for (const secret of [
      env.TWITCH_CLIENT_SECRET,
      env.SESSION_COOKIE_KEYS,
      env.SESSION_ENCRYPTION_KEYS,
      env.OVERLAY_TOKEN_PEPPER,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("starts a real Twitch OAuth redirect with PKCE, state and a binding cookie", async () => {
    const response = await fetchWorker("http://localhost/auth/twitch/start", {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const authorize = new URL(location ?? "");
    expect(authorize.host).toBe("id.twitch.tv");
    expect(authorize.pathname).toBe("/oauth2/authorize");
    expect(authorize.searchParams.get("client_id")).toBe(env.TWITCH_CLIENT_ID);
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${env.PUBLIC_ORIGIN}/auth/twitch/callback`,
    );
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get("state")).toMatch(/^v1\./);

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("irl-stream-hud-oauth-binding=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
  });
});
