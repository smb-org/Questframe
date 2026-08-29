import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  bootstrapResponseSchema,
  overlayTokenResponseSchema,
  renewMediaLeasesResponseSchema,
  saveResponseSchema,
  uploadResponseSchema,
  visibilityResponseSchema,
} from "../../src/shared/contracts/api";
import { OVERLAY_SOCKET_PROTOCOL } from "../../src/shared/contracts/protocol";
import { RequestError } from "../../src/worker/http";

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
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(503);
    expect(body.missingBindings).toEqual(
      expect.arrayContaining([
        "TWITCH_CLIENT_SECRET",
        "SESSION_COOKIE_KEYS",
        "SESSION_ENCRYPTION_KEYS",
        "OVERLAY_TOKEN_PEPPER",
      ]),
    );
    // Assert against the values actually bound in vitest.worker.config.ts
    // (read live from `env`, not re-typed here) so this fails the moment
    // /healthz ever echoes a bound secret back, instead of a string that
    // appears nowhere in the repository and so could never fail.
    for (const secret of [
      env.TWITCH_CLIENT_SECRET,
      env.SESSION_COOKIE_KEYS,
      env.SESSION_ENCRYPTION_KEYS,
      env.OVERLAY_TOKEN_PEPPER,
    ]) {
      expect(serialized).not.toContain(secret);
    }
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

    const upload = async (sideByte: number) => {
      const bytes = portraitWebP();
      bytes[24] = sideByte;
      bytes[27] = sideByte;
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

  it("filters an already-expired effect out of a saved draft instead of failing", async () => {
    const bootstrap = bootstrapResponseSchema.parse(
      await (
        await fetchWorker("http://localhost/api/editor/bootstrap", {
          headers: { cookie, "x-editor-tab": "test-tab-a" },
        })
      ).json(),
    );
    csrfToken = bootstrap.csrfToken;
    const { revision, overlayEnabled, updatedAt, updatedBy, ...draft } = bootstrap.state;
    expect([overlayEnabled, updatedAt, updatedBy]).toHaveLength(3);

    const response = await fetchWorker("http://localhost/api/state", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        baseRevision: revision,
        state: {
          ...draft,
          effects: [
            {
              id: "already-expired",
              catalogId: null,
              kind: "debuff",
              name: "Erschöpft",
              description: null,
              iconId: "already-expired-icon",
              stacks: null,
              expiresAt: "2000-01-01T00:00:00.000Z",
              order: 0,
            },
          ],
          featuredEffectId: null,
        },
      }),
    });
    const body = saveResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.state.effects).toEqual([]);
    bootstrapRevision = body.state.revision;
  });

  it("rejects a saved effect whose icon is not in the effect catalog", async () => {
    const bootstrap = bootstrapResponseSchema.parse(
      await (
        await fetchWorker("http://localhost/api/editor/bootstrap", {
          headers: { cookie, "x-editor-tab": "test-tab-a" },
        })
      ).json(),
    );
    csrfToken = bootstrap.csrfToken;
    const { revision, overlayEnabled, updatedAt, updatedBy, ...draft } = bootstrap.state;
    expect([overlayEnabled, updatedAt, updatedBy]).toHaveLength(3);

    const response = await fetchWorker("http://localhost/api/state", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        baseRevision: revision,
        state: {
          ...draft,
          effects: [
            {
              id: "unknown-icon-effect",
              catalogId: null,
              kind: "buff",
              name: "Selbstgebaut",
              description: null,
              iconId: "not-a-real-catalog-icon",
              stacks: null,
              expiresAt: null,
              order: 0,
            },
          ],
          featuredEffectId: null,
        },
      }),
    });
    const body = await response.json<{ error: { code: string; fieldErrors?: Record<string, string> } }>();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
    expect(typeof body.error.fieldErrors?.["effects[0].iconId"]).toBe("string");
  });

  it("turns a bare validation Error (too-soon effect expiry) into a 422 instead of a 500", async () => {
    const bootstrap = bootstrapResponseSchema.parse(
      await (
        await fetchWorker("http://localhost/api/editor/bootstrap", {
          headers: { cookie, "x-editor-tab": "test-tab-a" },
        })
      ).json(),
    );
    csrfToken = bootstrap.csrfToken;
    const { revision, overlayEnabled, updatedAt, updatedBy, ...draft } = bootstrap.state;
    expect([overlayEnabled, updatedAt, updatedBy]).toHaveLength(3);

    const tooSoon = new Date(Date.now() + 10_000).toISOString();
    const response = await fetchWorker("http://localhost/api/state", {
      method: "PUT",
      headers: authenticatedHeaders(),
      body: JSON.stringify({
        baseRevision: revision,
        state: {
          ...draft,
          effects: [
            {
              id: "too-soon-effect",
              catalogId: "buff-gestaerkt",
              kind: "buff",
              name: "Gestärkt",
              description: null,
              iconId: "buff-gestaerkt",
              stacks: null,
              expiresAt: tooSoon,
              order: 0,
            },
          ],
          featuredEffectId: null,
        },
      }),
    });
    const body = await response.json<{ error: { code: string; message: string } }>();

    // Vor dem Fix wurde dieses ungefangene `Error` aus validateEffectExpiries
    // zu einem 500 statt zu einem sauberen 422 mit Klartext-Meldung.
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message).toContain("mindestens einer Minute");
  });

  it("authorizes an overlay WebSocket by token, discards oversized frames and answers time sync", async () => {
    // Der zuvor rotierte OBS-Token aus "creates and rotates a read-only overlay
    // token idempotently" ist zu diesem Zeitpunkt der Datei noch aktiv (Generation 2).
    const overlayToken = "B".repeat(43);
    const upgrade = await fetchWorker("http://localhost/ws/overlay", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `${OVERLAY_SOCKET_PROTOCOL}, ${overlayToken}`,
      },
    });
    expect(upgrade.status).toBe(101);
    expect(upgrade.headers.get("sec-websocket-protocol")).toBe(OVERLAY_SOCKET_PROTOCOL);
    expect(upgrade.headers.get("sec-websocket-protocol")).not.toContain(overlayToken);
    const socket = upgrade.webSocket;
    expect(socket).not.toBeNull();
    if (socket === null) throw new Error("expected a WebSocket upgrade");
    socket.accept();

    const waitForMessage = (timeoutMs = 1_000): Promise<string | null> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          socket.removeEventListener("message", onMessage);
          resolve(null);
        }, timeoutMs);
        const onMessage = (event: MessageEvent) => {
          clearTimeout(timer);
          socket.removeEventListener("message", onMessage);
          resolve(typeof event.data === "string" ? event.data : null);
        };
        socket.addEventListener("message", onMessage);
      });

    try {
      const initial = await waitForMessage();
      expect(initial).not.toBeNull();
      expect(JSON.parse(initial as string)).toMatchObject({ type: "snapshot" });

      // Eine Nachricht über 98.304 Bytes wird verworfen, bevor sie geparst wird -
      // keine Antwort, keine Verbindung wird geschlossen.
      const oversized = JSON.stringify({
        type: "time_sync_request",
        clientTimestamp: 1,
        filler: "x".repeat(99_000),
      });
      expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(98_304);
      socket.send(oversized);
      expect(await waitForMessage(300)).toBeNull();
      expect(socket.readyState).toBe(1);

      socket.send(JSON.stringify({ type: "time_sync_request", clientTimestamp: 987_654 }));
      const reply = await waitForMessage();
      expect(reply).not.toBeNull();
      const parsed = JSON.parse(reply as string) as { type: string; clientTimestamp: number; serverTime: string };
      expect(parsed.type).toBe("time_sync");
      expect(parsed.clientTimestamp).toBe(987_654);
      expect(parsed.serverTime).toEqual(expect.any(String));
    } finally {
      // Bewusst ohne Code schliessen, genau wie die echten Clients. Der Server
      // erhaelt dadurch 1005 und darf ihn nicht zurueckspiegeln, sonst wirft
      // workerd bei jedem normalen Verbindungsabbau InvalidAccessError.
      socket.close();
    }
  });

  it("rejects an overlay WebSocket upgrade without a Sec-WebSocket-Protocol header", async () => {
    const response = await fetchWorker("http://localhost/ws/overlay", {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(403);
    const body = await response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("token_invalid");
    expect(body.error.message).toBe("OBS-Token ungültig.");
  });

  it("rejects an overlay WebSocket upgrade with the wrong subprotocol name", async () => {
    const overlayToken = "B".repeat(43);
    const response = await fetchWorker("http://localhost/ws/overlay", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `not-the-right-protocol, ${overlayToken}`,
      },
    });
    expect(response.status).toBe(403);
    const body = await response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("token_invalid");
  });

  it("rejects an overlay WebSocket upgrade with a formally invalid token", async () => {
    const response = await fetchWorker("http://localhost/ws/overlay", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `${OVERLAY_SOCKET_PROTOCOL}, not-a-valid-token`,
      },
    });
    expect(response.status).toBe(403);
    const body = await response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("token_invalid");
  });

  it("pushes the live OBS connection count to editor sockets as overlays connect and disconnect", async () => {
    const editorUpgrade = await fetchWorker("http://localhost/ws/editor?tab=test-tab-a", {
      headers: { cookie, upgrade: "websocket" },
    });
    expect(editorUpgrade.status).toBe(101);
    const editorSocket = editorUpgrade.webSocket;
    expect(editorSocket).not.toBeNull();
    if (editorSocket === null) throw new Error("expected a WebSocket upgrade");
    editorSocket.accept();

    const waitForMessage = (
      socket: WebSocket,
      predicate: (data: { type: string }) => boolean,
      timeoutMs = 1_000,
    ): Promise<Record<string, unknown> | null> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          socket.removeEventListener("message", onMessage);
          resolve(null);
        }, timeoutMs);
        const onMessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") return;
          const parsed = JSON.parse(event.data) as Record<string, unknown> & { type: string };
          if (!predicate(parsed)) return;
          clearTimeout(timer);
          socket.removeEventListener("message", onMessage);
          resolve(parsed);
        };
        socket.addEventListener("message", onMessage);
      });

    try {
      // Der Editor-Socket erhaelt zuerst den initialen Snapshot.
      const snapshot = await waitForMessage(editorSocket, (data) => data.type === "snapshot");
      expect(snapshot).not.toBeNull();

      // Der Listener muss VOR dem Verbindungsaufbau registriert werden: der Server
      // sendet overlay_presence synchron waehrend connectOverlay bearbeitet wird, ein
      // erst danach angehaengter Listener wuerde die Nachricht verpassen.
      const connectedPromise = waitForMessage(editorSocket, (data) => data.type === "overlay_presence");
      const overlayToken = "B".repeat(43);
      const overlayUpgrade = await fetchWorker("http://localhost/ws/overlay", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": `${OVERLAY_SOCKET_PROTOCOL}, ${overlayToken}`,
        },
      });
      expect(overlayUpgrade.status).toBe(101);
      const overlaySocket = overlayUpgrade.webSocket;
      expect(overlaySocket).not.toBeNull();
      if (overlaySocket === null) throw new Error("expected a WebSocket upgrade");
      overlaySocket.accept();

      try {
        const connected = await connectedPromise;
        expect(connected).toMatchObject({ type: "overlay_presence", connectedSockets: 1 });
      } finally {
        const disconnectedPromise = waitForMessage(editorSocket, (data) => data.type === "overlay_presence");
        overlaySocket.close();
        const disconnected = await disconnectedPromise;
        expect(disconnected).toMatchObject({ type: "overlay_presence", connectedSockets: 0 });
      }
    } finally {
      editorSocket.close();
    }
  });

  it("keeps ten overlay slots available through a full reload burst", async () => {
    const overlayToken = "D".repeat(43);
    const sockets: WebSocket[] = [];
    const connect = () =>
      fetchWorker("http://localhost/ws/overlay", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": `${OVERLAY_SOCKET_PROTOCOL}, ${overlayToken}`,
        },
      });
    const stub = env.CHANNEL.get(env.CHANNEL.idFromName(`channel:${env.BROADCASTER_ID}`));
    const overlaySocketCount = () =>
      runInDurableObject(stub, (_instance, state) => state.getWebSockets("overlay").length);
    const waitForSocketCount = async (expected: number): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await overlaySocketCount()) === expected) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`expected ${String(expected)} overlay sockets`);
    };

    try {
      const bootstrap = bootstrapResponseSchema.parse(
        await (
          await fetchWorker("http://localhost/api/editor/bootstrap", {
            headers: { cookie, "x-editor-tab": "test-tab-a" },
          })
        ).json(),
      );
      csrfToken = bootstrap.csrfToken;
      expect(bootstrap.capsule.overlayToken.generation).toBe(2);
      const rotation = await fetchWorker("http://localhost/api/overlay-token/rotate", {
        method: "POST",
        headers: authenticatedHeaders(),
        body: JSON.stringify({
          requestId: "951cf197-8068-4fb6-b884-3fe3146a1468",
          expectedGeneration: 2,
          candidateToken: overlayToken,
        }),
      });
      expect(rotation.status).toBe(200);
      expect(overlayTokenResponseSchema.parse(await rotation.json())).toMatchObject({ generation: 3 });

      const upgrades = await Promise.all(Array.from({ length: 10 }, () => connect()));
      for (const upgrade of upgrades) {
        const socket = upgrade.webSocket;
        if (socket !== null) {
          socket.accept();
          sockets.push(socket);
        }
      }
      expect(upgrades.map((upgrade) => upgrade.status)).toEqual(Array(10).fill(101));
      expect(await overlaySocketCount()).toBe(10);

      const reloadOverlaps = await Promise.all(Array.from({ length: 10 }, () => connect()));
      for (const response of reloadOverlaps) {
        expect(response.status).toBe(429);
        expect((await response.json<{ error: { code: string } }>()).error.code).toBe("socket_limit");
      }

      for (const socket of sockets.splice(0)) socket.close();
      await waitForSocketCount(0);

      const replacements = await Promise.all(Array.from({ length: 10 }, () => connect()));
      for (const replacement of replacements) {
        const socket = replacement.webSocket;
        if (socket !== null) {
          socket.accept();
          sockets.push(socket);
        }
      }
      expect(replacements.map((replacement) => replacement.status)).toEqual(Array(10).fill(101));
      expect(await overlaySocketCount()).toBe(10);
    } finally {
      for (const socket of sockets) socket.close();
      await waitForSocketCount(0);
    }
  });

  it("admits only ten overlays when eleven HMAC checks finish together", async () => {
    const originalSign = crypto.subtle.sign.bind(crypto.subtle);
    let releaseHmacs = (): void => undefined;
    let markAllHmacsStarted = (): void => undefined;
    const allHmacsStarted = new Promise<void>((resolve) => {
      markAllHmacsStarted = resolve;
    });
    const hmacRelease = new Promise<void>((resolve) => {
      releaseHmacs = resolve;
    });
    let startedHmacs = 0;
    const signSpy = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      startedHmacs += 1;
      if (startedHmacs === 11) markAllHmacsStarted();
      await hmacRelease;
      return originalSign(...args);
    });

    try {
      const stub = env.CHANNEL.get(env.CHANNEL.idFromName(`channel:${env.BROADCASTER_ID}`));
      const result = await runInDurableObject(stub, async (instance, state) => {
        const connectOverlay = (
          instance as unknown as {
            connectOverlay(request: Request): Promise<Response>;
          }
        ).connectOverlay.bind(instance);
        const attempts = Array.from({ length: 11 }, async () => {
          try {
            const response = await connectOverlay(
              new Request("https://channel.internal/ws/overlay", {
                headers: { upgrade: "websocket", "x-overlay-token": "D".repeat(43) },
              }),
            );
            const socket = response.webSocket;
            if (socket !== null) {
              socket.accept();
              socket.close();
            }
            return { status: response.status, errorCode: undefined };
          } catch (error) {
            if (!(error instanceof RequestError)) throw error;
            return { status: error.status, errorCode: error.code };
          }
        });
        await allHmacsStarted;
        releaseHmacs();
        const outcomes = await Promise.all(attempts);
        return {
          outcomes,
          connectedSockets: state.getWebSockets("overlay").length,
        };
      });
      expect(result.outcomes.filter(({ status }) => status === 101)).toHaveLength(10);
      expect(result.outcomes.filter(({ errorCode }) => errorCode === "socket_limit")).toHaveLength(1);
      expect(result.connectedSockets).toBe(10);
    } finally {
      releaseHmacs();
      signSpy.mockRestore();
    }

    const stub = env.CHANNEL.get(env.CHANNEL.idFromName(`channel:${env.BROADCASTER_ID}`));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const connected = await runInDurableObject(
        stub,
        (_instance, state) => state.getWebSockets("overlay").length,
      );
      if (connected === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("expected all parallel overlay sockets to close");
  });

  it("rejects an old overlay token when rotation finishes during its HMAC check", async () => {
    const originalSign = crypto.subtle.sign.bind(crypto.subtle);
    let releaseHmac = (): void => undefined;
    let markHmacStarted = (): void => undefined;
    const hmacStarted = new Promise<void>((resolve) => {
      markHmacStarted = resolve;
    });
    const hmacRelease = new Promise<void>((resolve) => {
      releaseHmac = resolve;
    });
    let blockFirstSign = true;
    const signSpy = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      if (blockFirstSign) {
        blockFirstSign = false;
        markHmacStarted();
        await hmacRelease;
      }
      return originalSign(...args);
    });
    try {
      const stub = env.CHANNEL.get(env.CHANNEL.idFromName(`channel:${env.BROADCASTER_ID}`));
      const staleResult = await runInDurableObject(stub, async (instance, state) => {
        const staleConnection = (
          instance as unknown as {
            connectOverlay(request: Request): Promise<Response>;
          }
        ).connectOverlay(
          new Request("https://channel.internal/ws/overlay", {
            headers: { upgrade: "websocket", "x-overlay-token": "D".repeat(43) },
          }),
        );
        await hmacStarted;
        state.storage.sql.exec(
          "UPDATE overlay_tokens SET token_hash = ?, generation = ? WHERE singleton = 1",
          "rotated-while-hashing",
          3,
        );
        releaseHmac();
        try {
          const response = await staleConnection;
          const socket = response.webSocket;
          if (socket !== null) {
            socket.accept();
            socket.close();
          }
          return { status: response.status, errorCode: undefined };
        } catch (error) {
          if (!(error instanceof RequestError)) throw error;
          return { status: error.status, errorCode: error.code };
        }
      });
      expect(staleResult).toEqual({ status: 403, errorCode: "token_invalid" });
    } finally {
      releaseHmac();
      signSpy.mockRestore();
    }
  });

  it("replaces a stale login row instead of hitting a UNIQUE constraint when caching a Twitch user", async () => {
    const stub = env.CHANNEL.get(env.CHANNEL.idFromName(`channel:${env.BROADCASTER_ID}`));
    const cache = (user: { id: string; login: string; displayName: string; profileImageUrl: string }) =>
      stub.fetch("https://channel.internal/internal/twitch/cache", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user }),
      });

    const first = await cache({
      id: "10000000000000000001",
      login: "gast_tv",
      displayName: "GastTV Alt",
      profileImageUrl: "https://example.test/alt.png",
    });
    expect(first.status).toBe(200);

    // Ein zweiter Twitch-Account beansprucht denselben Login (z.B. nach einer
    // Umbenennung). Vor dem Fix knallte hier ein unbehandelter UNIQUE-Constraint
    // auf `login` mit einem 500.
    const second = await cache({
      id: "20000000000000000002",
      login: "gast_tv",
      displayName: "GastTV Neu",
      profileImageUrl: "https://example.test/neu.png",
    });
    expect(second.status).toBe(200);

    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ twitch_user_id: string; display_name: string }>(
          "SELECT twitch_user_id, display_name FROM twitch_user_cache WHERE login = ?",
          "gast_tv",
        )
        .toArray(),
    );
    expect(rows).toEqual([{ twitch_user_id: "20000000000000000002", display_name: "GastTV Neu" }]);
  });

  it("purges csrf_tokens along with an expired session instead of leaving them orphaned", async () => {
    // Diese Test läuft absichtlich als letzter in der Datei: er lässt die im
    // beforeAll erzeugte Sitzung ablaufen und macht `cookie`/`csrfToken`
    // damit für alle nachfolgenden Tests unbrauchbar.
    const stub = env.CHANNEL.get(env.CHANNEL.idFromName(`channel:${env.BROADCASTER_ID}`));
    const sessionHash = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ session_hash: string }>("SELECT session_hash FROM editor_sessions LIMIT 1")
        .toArray()[0]?.session_hash,
    );
    expect(sessionHash).toBeDefined();

    const csrfBefore = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) as count FROM csrf_tokens WHERE session_hash = ?",
          sessionHash,
        )
        .toArray()[0]?.count,
    );
    expect(csrfBefore).toBeGreaterThan(0);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE editor_sessions SET idle_expires_at = ?, absolute_expires_at = ? WHERE session_hash = ?",
        "2000-01-01T00:00:00.000Z",
        "2000-01-01T00:00:00.000Z",
        sessionHash,
      );
    });

    const response = await fetchWorker("http://localhost/api/editor/bootstrap", {
      headers: { cookie, "x-editor-tab": "test-tab-a" },
    });
    const body = await response.json<{ error: { code: string } }>();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");

    const [sessionAfter, csrfAfter] = await runInDurableObject(stub, (_instance, state) => [
      state.storage.sql
        .exec<{ session_hash: string }>("SELECT session_hash FROM editor_sessions WHERE session_hash = ?", sessionHash)
        .toArray()[0],
      state.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) as count FROM csrf_tokens WHERE session_hash = ?",
          sessionHash,
        )
        .toArray()[0]?.count,
    ]);
    expect(sessionAfter).toBeUndefined();
    expect(csrfAfter).toBe(0);
  });
});
