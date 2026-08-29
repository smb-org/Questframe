import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

let cookie = "";

const fetchWorker = (path: string, init?: RequestInit): Promise<Response> =>
  exports.default.fetch(new Request(`http://localhost${path}`, init));

const errorCode = async (response: Response): Promise<string | undefined> =>
  (await response.json<{ error?: { code?: string } }>()).error?.code;

describe("Worker gateway failure boundaries", () => {
  beforeAll(async () => {
    const response = await fetchWorker("/auth/dev", { redirect: "manual" });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  });

  it("fails closed on unknown application routes and delegates ordinary assets", async () => {
    const api = await fetchWorker("/api/unknown");
    expect(api.status).toBe(404);
    expect(await errorCode(api)).toBe("not_found");

    const auth = await fetchWorker("/auth/unknown");
    expect(auth.status).toBe(404);
    const socket = await fetchWorker("/ws/unknown");
    expect(socket.status).toBe(404);

    const shell = await fetchWorker("/admin");
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toContain("text/html");
  });

  it("redirects incomplete or malformed OAuth attempts without exposing details", async () => {
    const start = await fetchWorker("/auth/twitch/start", { redirect: "manual" });
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toBe("http://localhost:5173/login?error=misconfigured");

    const callback = await fetchWorker("/auth/twitch/callback?code=only-code", { redirect: "manual" });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("error=oauth_invalid");
  });

  it("requires a valid session, tab and same-origin mutation", async () => {
    const bootstrap = await fetchWorker("/api/editor/bootstrap");
    expect(bootstrap.status).toBe(401);

    const wrongOrigin = await fetchWorker("/api/auth/revalidate", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(wrongOrigin.status).toBe(403);
    expect(await errorCode(wrongOrigin)).toBe("forbidden");

    const missingSession = await fetchWorker("/api/auth/revalidate", {
      method: "POST",
      headers: { origin: "http://localhost:5173", "x-editor-tab": "tab" },
    });
    expect(missingSession.status).toBe(401);
    const missingTab = await fetchWorker("/api/auth/revalidate", {
      method: "POST",
      headers: { origin: "http://localhost:5173", cookie },
    });
    expect(missingTab.status).toBe(401);

    const tampered = await fetchWorker("/api/editor/bootstrap", {
      headers: { cookie: "irl-stream-hud-session=tampered", "x-editor-tab": "tab" },
    });
    expect(tampered.status).toBe(401);
  });

  it("rejects every cross-origin state mutation before the Durable Object", async () => {
    for (const path of [
      "/api/state",
      "/api/state/undo",
      "/api/overlay-visibility",
      "/api/overlay-token",
      "/api/overlay-token/rotate",
      "/api/media",
      "/api/media/leases/renew",
      "/auth/logout",
    ]) {
      const response = await fetchWorker(path, {
        method: "POST",
        headers: { origin: "https://evil.example", cookie },
        body: "{}",
      });
      expect(response.status, path).toBe(403);
      expect(await errorCode(response), path).toBe("forbidden");
    }
  });

  it("validates editor and overlay socket gateway parameters", async () => {
    const editor = await fetchWorker("/ws/editor", { headers: { cookie } });
    expect(editor.status).toBe(400);
    expect(await errorCode(editor)).toBe("bad_request");

    const unauthorizedEditor = await fetchWorker("/ws/editor?tab=test-tab");
    expect(unauthorizedEditor.status).toBe(400);

    const overlay = await fetchWorker("/ws/overlay");
    expect(overlay.status).toBe(403);
    expect(await errorCode(overlay)).toBe("token_invalid");
    const invalidOverlay = await fetchWorker("/ws/overlay?token=short");
    expect(invalidOverlay.status).toBe(400);
  });

  it("validates Twitch guest lookup before any upstream request", async () => {
    const wrongOrigin = await fetchWorker("/api/twitch/users?login=gast_tv", {
      headers: { origin: "https://evil.example" },
    });
    expect(wrongOrigin.status).toBe(403);
    expect(await errorCode(wrongOrigin)).toBe("forbidden");

    const anonymous = await fetchWorker("/api/twitch/users?login=gast_tv", {
      headers: { origin: "http://localhost:5173" },
    });
    expect(anonymous.status).toBe(401);
    const invalid = await fetchWorker("/api/twitch/users?login=not%20valid", {
      headers: { origin: "http://localhost:5173", cookie },
    });
    expect(invalid.status).toBe(422);
    expect(await errorCode(invalid)).toBe("validation_failed");
  });

  it("protects media reads and clears a same-origin logout cookie", async () => {
    const missing = await fetchWorker(`/api/media/${"a".repeat(64)}`);
    expect(missing.status).toBe(403);
    const badBearer = await fetchWorker(`/api/media/${"a".repeat(64)}`, {
      headers: { authorization: "Bearer short" },
    });
    expect(badBearer.status).toBe(403);

    const logout = await fetchWorker("/auth/logout", {
      method: "POST",
      headers: { origin: "http://localhost:5173", cookie },
      body: "{}",
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
