import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  bootstrapResponseSchema,
  overlayTokenResponseSchema,
  renewMediaLeasesResponseSchema,
  saveResponseSchema,
  uploadResponseSchema,
  visibilityResponseSchema,
} from "../../src/shared/contracts/api";

let cookie = "";
let csrfToken = "";
let bootstrapRevision = 0;

const fetchWorker = (input: string, init?: RequestInit): Promise<Response> =>
  exports.default.fetch(new Request(input, init));

const portraitWebP = (): Uint8Array => {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(bytes.buffer).setUint32(4, 22, true);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  bytes[24] = 63;
  bytes[27] = 63;
  return bytes;
};

const authenticatedHeaders = (): HeadersInit => ({
  cookie,
  "x-editor-tab": "test-tab-a",
  "x-csrf-token": csrfToken,
  origin: "http://localhost:5173",
  "content-type": "application/json",
});

describe("channel worker", () => {
  beforeAll(async () => {
    const login = await fetchWorker("http://localhost/auth/dev", {
      redirect: "manual",
    });
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  });

  it("reports secret names but never values when local deployment is incomplete", async () => {
    const response = await fetchWorker("http://localhost/healthz");
    const body = await response.json<{ missingBindings: string[] }>();

    expect(response.status).toBe(503);
    expect(body.missingBindings).toEqual(
      expect.arrayContaining([
        "TWITCH_CLIENT_SECRET",
        "SESSION_COOKIE_KEYS",
        "SESSION_ENCRYPTION_KEYS",
        "OVERLAY_TOKEN_PEPPER",
      ]),
    );
    expect(JSON.stringify(body)).not.toContain("secret-value");
  });

  it("creates an authenticated local editor session and complete bootstrap", async () => {
    expect(cookie).toMatch(/^irl-stream-hud-session=/);
    const response = await fetchWorker("http://localhost/api/editor/bootstrap", {
      headers: { cookie, "x-editor-tab": "test-tab-a" },
    });
    const body = bootstrapResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.editor).toMatchObject({
      twitchUserId: "12345678901234567890",
      role: "editor",
    });
    expect(body.state.revision).toBeGreaterThanOrEqual(1);
    expect(body.capabilities.phase).toBe("v1b");
    csrfToken = body.csrfToken;
    bootstrapRevision = body.state.revision;
  });

  it("publishes one complete draft and rejects stale writes", async () => {
    const bootstrap = bootstrapResponseSchema.parse(
      await (
        await fetchWorker("http://localhost/api/editor/bootstrap", {
          headers: { cookie, "x-editor-tab": "test-tab-a" },
        })
      ).json(),
    );
    csrfToken = bootstrap.csrfToken;
    bootstrapRevision = bootstrap.state.revision;
    const { revision: _revision, overlayEnabled: _enabled, updatedAt: _at, updatedBy: _by, ...draft } =
      bootstrap.state;
    expect([_revision, _enabled, _at, _by]).toHaveLength(4);

    const first = await fetchWorker("http://localhost/api/state", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        baseRevision: bootstrapRevision,
        state: {
          ...draft,
          player: { ...draft.player, hpPercent: 49, resource: { ...draft.player.resource, percent: 77 } },
        },
      }),
    });
    const committed = saveResponseSchema.parse(await first.json());
    expect(first.status).toBe(200);
    expect(committed.state).toMatchObject({
      revision: bootstrapRevision + 1,
      overlayEnabled: bootstrap.state.overlayEnabled,
      player: { hpPercent: 49, resource: { percent: 77 } },
    });

    const stale = await fetchWorker("http://localhost/api/state", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ baseRevision: bootstrapRevision, state: draft }),
    });
    const conflict = await stale.json<{ error: { code: string; currentRevision: number } }>();
    expect(stale.status).toBe(409);
    expect(conflict.error).toMatchObject({
      code: "revision_conflict",
      currentRevision: committed.state.revision,
    });
    bootstrapRevision = committed.state.revision;
  });

  it("toggles output immediately without accepting a stale draft", async () => {
    const response = await fetchWorker("http://localhost/api/overlay-visibility", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ enabled: false }),
    });
    const body = visibilityResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.state.overlayEnabled).toBe(false);
    expect(body.state.revision).toBe(bootstrapRevision + 1);
    expect(body.auditEntry?.action).toBe("overlay_disable");
    bootstrapRevision = body.state.revision;

    const noOp = await fetchWorker("http://localhost/api/overlay-visibility", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ enabled: false }),
    });
    const noOpBody = visibilityResponseSchema.parse(await noOp.json());
    expect(noOpBody.state.revision).toBe(bootstrapRevision);
    expect(noOpBody.auditEntry).toBeNull();
  });

  it("creates and rotates a read-only overlay token idempotently", async () => {
    const firstRequest = {
      requestId: "dc95708a-645a-4bc0-9ca3-7ffbd42e6662",
      expectedGeneration: 0,
      candidateToken: "A".repeat(43),
    };
    const create = await fetchWorker("http://localhost/api/overlay-token", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify(firstRequest),
    });
    const created = overlayTokenResponseSchema.parse(await create.json());
    expect(created).toMatchObject({ generation: 1, requestId: firstRequest.requestId });

    const retry = await fetchWorker("http://localhost/api/overlay-token", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify(firstRequest),
    });
    expect(overlayTokenResponseSchema.parse(await retry.json())).toEqual(created);

    const rotate = await fetchWorker("http://localhost/api/overlay-token/rotate", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        requestId: "74d8c1e3-c4d2-4486-b185-c15a35b742ea",
        expectedGeneration: 1,
        candidateToken: "B".repeat(43),
      }),
    });
    expect(overlayTokenResponseSchema.parse(await rotate.json())).toMatchObject({ generation: 2 });
  });

  it("undoes a retained state revision while preserving visibility", async () => {
    const bootstrap = bootstrapResponseSchema.parse(
      await (
        await fetchWorker("http://localhost/api/editor/bootstrap", {
          headers: { cookie, "x-editor-tab": "test-tab-a" },
        })
      ).json(),
    );
    csrfToken = bootstrap.csrfToken;
    const target = bootstrap.undoTargets.at(-1);
    expect(target).toBeDefined();
    const response = await fetchWorker("http://localhost/api/state/undo", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        baseRevision: bootstrap.state.revision,
        targetRevision: target?.revision,
      }),
    });
    const body = saveResponseSchema.parse(await response.json());
    expect(body.auditEntry.action).toBe("undo");
    expect(body.state.revision).toBe(bootstrap.state.revision + 1);
    expect(body.state.overlayEnabled).toBe(false);
  });

  it("leases bounded WebP portraits and authorizes their bytes", async () => {
    const bootstrap = bootstrapResponseSchema.parse(
      await (
        await fetchWorker("http://localhost/api/editor/bootstrap", {
          headers: { cookie, "x-editor-tab": "test-tab-a" },
        })
      ).json(),
    );
    csrfToken = bootstrap.csrfToken;
    const uploadHeaders = new Headers(authenticatedHeaders());
    uploadHeaders.set("content-type", "image/webp");
    const upload = await fetchWorker("http://localhost/api/media", {
      method: "POST",
      headers: uploadHeaders,
      body: Uint8Array.from(portraitWebP()).buffer,
    });
    const uploaded = uploadResponseSchema.parse(await upload.json());
    expect(uploaded).toMatchObject({ width: 64, height: 64, byteLength: 30 });

    const media = await fetchWorker(
      `http://localhost/api/media/${uploaded.portrait.contentHash}`,
      { headers: { cookie } },
    );
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(portraitWebP());

    const renewal = await fetchWorker("http://localhost/api/media/leases/renew", {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ contentHashes: [uploaded.portrait.contentHash] }),
    });
    expect(renewMediaLeasesResponseSchema.parse(await renewal.json()).leases).toHaveLength(1);

    const { revision, overlayEnabled, updatedAt, updatedBy, ...draft } = bootstrap.state;
    expect([overlayEnabled, updatedAt, updatedBy]).toHaveLength(3);
    const save = await fetchWorker("http://localhost/api/state", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        baseRevision: revision,
        state: {
          ...draft,
          player: { ...draft.player, portrait: uploaded.portrait },
        },
      }),
    });
    expect(save.status).toBe(200);
    expect(saveResponseSchema.parse(await save.json()).state.player.portrait).toEqual(uploaded.portrait);
  });

  it("collects expired unreferenced media without deleting state or history portraits", async () => {
    const bootstrap = bootstrapResponseSchema.parse(
      await (
        await fetchWorker("http://localhost/api/editor/bootstrap", {
          headers: { cookie, "x-editor-tab": "test-tab-a" },
        })
      ).json(),
    );
    csrfToken = bootstrap.csrfToken;
    const originalPortrait = bootstrap.state.player.portrait;
    expect(originalPortrait.kind).toBe("uploaded");

    const upload = async (widthByte: number) => {
      const bytes = portraitWebP();
      bytes[24] = widthByte;
      const headers = new Headers(authenticatedHeaders());
      headers.set("content-type", "image/webp");
      const response = await fetchWorker("http://localhost/api/media", {
        method: "POST",
        headers,
        body: Uint8Array.from(bytes).buffer,
      });
      expect(response.status).toBe(200);
      return uploadResponseSchema.parse(await response.json()).portrait;
    };

    const historicalPortrait = await upload(64);
    const { revision, overlayEnabled, updatedAt, updatedBy, ...draft } = bootstrap.state;
    expect([overlayEnabled, updatedAt, updatedBy]).toHaveLength(3);
    const save = await fetchWorker("http://localhost/api/state", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        baseRevision: revision,
        state: {
          ...draft,
          player: { ...draft.player, portrait: historicalPortrait },
        },
      }),
    });
    expect(save.status).toBe(200);

    const orphanedPortrait = await upload(65);
    expect(orphanedPortrait.kind).toBe("uploaded");
    const orphanedHash = orphanedPortrait.contentHash;
    const stub = env.CHANNEL.get(env.CHANNEL.idFromName(`channel:${env.BROADCASTER_ID}`));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE media_leases SET expires_at = ? WHERE content_hash = ?",
        "2000-01-01T00:00:00.000Z",
        orphanedHash,
      );
    });

    await upload(66);

    const orphaned = await fetchWorker(`http://localhost/api/media/${orphanedHash}`, {
      headers: { cookie },
    });
    expect(orphaned.status).toBe(404);

    for (const portrait of [originalPortrait, historicalPortrait]) {
      expect(portrait.kind).toBe("uploaded");
      if (portrait.kind !== "uploaded") continue;
      const retained = await fetchWorker(
        `http://localhost/api/media/${portrait.contentHash}`,
        { headers: { cookie } },
      );
      expect(retained.status).toBe(200);
    }
  });
});
