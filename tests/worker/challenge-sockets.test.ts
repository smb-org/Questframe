import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_CHALLENGE_SOCKETS,
  MAX_COMPOSITE_SOCKETS,
  bootstrapResponseSchema,
  dockTokenResponseSchema,
  overlayTokenResponseSchema,
  saveResponseSchema,
  type BootstrapResponse,
} from "../../src/shared/contracts/api";
import { DOCK_SOCKET_PROTOCOL, OVERLAY_SOCKET_PROTOCOL } from "../../src/shared/contracts/protocol";

const origin = "http://localhost:5173";
const tabId = "challenge-socket-test";
const stub = env.CHANNEL.get(env.CHANNEL.idFromName(`channel:${env.BROADCASTER_ID}`));

let cookie = "";
let csrfToken = "";

const fetchWorker = (path: string, init?: RequestInit): Promise<Response> =>
  exports.default.fetch(new Request(`http://localhost${path}`, init));

const authenticatedHeaders = (): HeadersInit => ({
  cookie,
  origin,
  "x-editor-tab": tabId,
  "x-csrf-token": csrfToken,
  "content-type": "application/json",
});

const commandId = (): string => crypto.randomUUID();

// Spiegel der Budgets aus wrangler.jsonc. workerd hat kein Dateisystem, die
// Datei lässt sich hier also nicht lesen; dass Config und diese Zahlen
// zusammenpassen und genug Luft lassen, prüft tests/unit/config/wrangler.test.ts.
const ipLimit = 100;
const capsuleLimit = 300;

// Modulo hält den Präfix immer bei zwei Ziffern (43 Zeichen gesamt), auch wenn
// eine Rate-Limit-Schleife weit über 99 Versuche hinaus zählt.
const formalToken = (index: number): string =>
  `${String(index % 100).padStart(2, "0")}${"A".repeat(41)}`;

type SocketInbox = {
  messages: Record<string, unknown>[];
  waiters: Array<{
    predicate: (data: Record<string, unknown>) => boolean;
    resolve: (data: Record<string, unknown> | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
};

const socketInboxes = new WeakMap<WebSocket, SocketInbox>();

const getBootstrap = async (): Promise<BootstrapResponse> => {
  const response = await fetchWorker("/api/editor/bootstrap", { headers: { cookie, "x-editor-tab": tabId } });
  expect(response.status).toBe(200);
  return bootstrapResponseSchema.parse(await response.json());
};

const getBootstrapFor = async (sessionCookie: string, editorTab: string): Promise<BootstrapResponse> => {
  const response = await fetchWorker("/api/editor/bootstrap", {
    headers: { cookie: sessionCookie, "x-editor-tab": editorTab },
  });
  expect(response.status).toBe(200);
  return bootstrapResponseSchema.parse(await response.json());
};

const refreshCsrf = async (): Promise<BootstrapResponse> => {
  const bootstrap = await getBootstrap();
  csrfToken = bootstrap.csrfToken;
  return bootstrap;
};

const resetTables = async (): Promise<void> => {
  await runInDurableObject(stub, (_instance, state) => {
    for (const tag of ["editor", "overlay", "composite", "challenge", "dock"] as const) {
      for (const socket of state.getWebSockets(tag)) socket.close();
    }
    state.storage.sql.exec("DELETE FROM wc_challenges");
    state.storage.sql.exec("DELETE FROM wc_commands");
    state.storage.sql.exec("DELETE FROM wc_dock_tokens");
    state.storage.sql.exec("DELETE FROM overlay_tokens");
    state.storage.sql.exec(
      `UPDATE wc_meta SET
        event_seq = 0, board_revision = 1, settings_revision = 1,
        style_id = 'plain-list', theme_mode = 'inherit', surface_mode = 'surface', header_style = 'default',
        header_title = 'CHALLENGES', effects_enabled = 1, max_visible = 5,
        overflow_mode = 'cut', overflow_tempo = 'medium', numbered = 0, done_order = 'end',
        placement_x = 300, placement_y = 8, placement_scale = 1,
        global_timer_total_ms = NULL, global_timer_ends_at = NULL,
        global_timer_paused_remain_ms = NULL
       WHERE singleton = 1`,
    );
  });
};

const createOverlayToken = async (): Promise<string> => {
  const bootstrap = await refreshCsrf();
  const response = await fetchWorker("/api/overlay-token", {
    method: "POST",
    headers: authenticatedHeaders(),
    body: JSON.stringify({ requestId: commandId(), expectedGeneration: bootstrap.capsule.overlayToken.generation }),
  });
  expect(response.status).toBe(200);
  return overlayTokenResponseSchema.parse(await response.json()).token;
};

const createDockToken = async (): Promise<string> => {
  const bootstrap = await refreshCsrf();
  const response = await fetchWorker("/api/challenges/dock-token", {
    method: "POST",
    headers: authenticatedHeaders(),
    body: JSON.stringify({
      requestId: commandId(),
      expectedGeneration: bootstrap.capsule.dockToken?.generation ?? 0,
    }),
  });
  expect(response.status).toBe(200);
  return dockTokenResponseSchema.parse(await response.json()).token;
};

const openSocket = async (
  path: string,
  protocol: string | null,
  token: string,
  extraHeaders: HeadersInit = {},
): Promise<WebSocket> => {
  const headers = new Headers(extraHeaders);
  headers.set("upgrade", "websocket");
  if (protocol !== null) headers.set("sec-websocket-protocol", `${protocol}, ${token}`);
  const response = await fetchWorker(path, {
    headers,
  });
  expect(response.status, path).toBe(101);
  const socket = response.webSocket;
  expect(socket, path).not.toBeNull();
  if (socket === null) throw new Error(`WebSocket-Upgrade für ${path} fehlt.`);
  socket.accept();
  attachSocketInbox(socket);
  return socket;
};

const openEditorSocketFor = async (sessionCookie: string, editorTab: string): Promise<WebSocket> => {
  const response = await fetchWorker(`/ws/editor?tab=${editorTab}`, {
    headers: { cookie: sessionCookie, upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).not.toBeNull();
  if (socket === null) throw new Error("Editor-WebSocket-Upgrade fehlt.");
  socket.accept();
  attachSocketInbox(socket);
  return socket;
};

const openEditorSocket = async (): Promise<WebSocket> => openEditorSocketFor(cookie, tabId);

const attachSocketInbox = (socket: WebSocket): void => {
  const inbox: SocketInbox = { messages: [], waiters: [] };
  socketInboxes.set(socket, inbox);
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    const waiterIndex = inbox.waiters.findIndex(({ predicate }) => predicate(parsed));
    const waiter = waiterIndex === -1 ? undefined : inbox.waiters.splice(waiterIndex, 1)[0];
    if (waiter === undefined) {
      inbox.messages.push(parsed);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(parsed);
  });
};

const waitForMessage = (
  socket: WebSocket,
  predicate: (data: Record<string, unknown>) => boolean,
  timeoutMs = 1_000,
): Promise<Record<string, unknown> | null> => {
  const inbox = socketInboxes.get(socket);
  if (inbox === undefined) return Promise.resolve(null);
  const queuedIndex = inbox.messages.findIndex(predicate);
  if (queuedIndex !== -1) return Promise.resolve(inbox.messages.splice(queuedIndex, 1)[0] ?? null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const waiterIndex = inbox.waiters.findIndex((waiter) => waiter.resolve === resolve);
      if (waiterIndex !== -1) inbox.waiters.splice(waiterIndex, 1);
      resolve(null);
    }, timeoutMs);
    inbox.waiters.push({ predicate, resolve, timer });
  });
};

const requireMessage = async (
  socket: WebSocket,
  predicate: (data: Record<string, unknown>) => boolean,
  description: string,
): Promise<Record<string, unknown>> => {
  const message = await waitForMessage(socket, predicate);
  expect(message, description).not.toBeNull();
  if (message === null) throw new Error(`Nachricht fehlt: ${description}`);
  return message;
};

const expectChallengeUpdateShape = (message: Record<string, unknown>): void => {
  expect(typeof message.eventSeq).toBe("number");
  expect(typeof message.boardRevision).toBe("number");
  expect(typeof message.settingsRevision).toBe("number");
  expect(message.settings).toBeDefined();
  expect(Array.isArray(message.challenges)).toBe(true);
};

const waitForClose = (socket: WebSocket, timeoutMs = 1_000): Promise<CloseEvent | null> =>
  new Promise((resolve) => {
    if (socket.readyState === 3) {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      socket.removeEventListener("close", onClose);
      resolve(null);
    }, timeoutMs);
    const onClose = (event: Event) => {
      clearTimeout(timer);
      socket.removeEventListener("close", onClose);
      resolve(event as CloseEvent);
    };
    socket.addEventListener("close", onClose);
  });

const challengeDefinition = {
  clientId: "socket-challenge",
  title: "Socket-Challenge",
  targetCount: 3,
  timerTotalMs: 10_000,
  sortOrder: 0,
  hidden: false,
} as const;

const saveBoard = () =>
  fetchWorker("/api/challenges/board", {
    method: "PUT",
    headers: authenticatedHeaders(),
    body: JSON.stringify({ baseBoardRevision: 1, challenges: [challengeDefinition] }),
  });

const expectClose = async (socket: WebSocket, code: number, reason: string): Promise<void> => {
  const event = await waitForClose(socket);
  expect(event).not.toBeNull();
  if (event === null) throw new Error("WebSocket wurde nicht geschlossen.");
  expect(event.code).toBe(code);
  expect(event.reason).toBe(reason);
};

describe("Win-Challenges-Sockets", () => {
  beforeAll(async () => {
    const login = await fetchWorker("/auth/dev", { redirect: "manual" });
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  });

  beforeEach(async () => {
    await resetTables();
    await refreshCsrf();
  });

  it("trennt HUD-State, liefert fünf Attachments und broadcastet Updates gezielt", async () => {
    const bootstrap = await refreshCsrf();
    const overlayToken = await createOverlayToken();
    const dockToken = await createDockToken();
    const editor = await openEditorSocket();
    const overlay = await openSocket("/ws/overlay", OVERLAY_SOCKET_PROTOCOL, overlayToken);
    const challenge = await openSocket("/ws/challenge", OVERLAY_SOCKET_PROTOCOL, overlayToken);
    const dock = await openSocket("/ws/dock", DOCK_SOCKET_PROTOCOL, dockToken);
    const composite = await openSocket("/ws/composite", OVERLAY_SOCKET_PROTOCOL, overlayToken);

    try {
      const editorSnapshot = await requireMessage(
        editor,
        (data) => data.type === "snapshot",
        "Editor-Snapshot",
      );
      expect(editorSnapshot.type).toBe("snapshot");
      expect(editorSnapshot.state).toBeDefined();
      expect(typeof editorSnapshot.state).toBe("object");
      const overlaySnapshot = await requireMessage(
        overlay,
        (data) => data.type === "snapshot",
        "Overlay-Snapshot",
      );
      expect(overlaySnapshot.type).toBe("snapshot");
      expect(overlaySnapshot.state).toBeDefined();
      expect(typeof overlaySnapshot.state).toBe("object");
      const challengeSnapshot = await requireMessage(
        challenge,
        (data) => data.event === null,
        "Challenge-Snapshot",
      );
      expectChallengeUpdateShape(challengeSnapshot);
      expect(challengeSnapshot.event).toBeNull();
      const dockSnapshot = await requireMessage(
        dock,
        (data) => data.event === null,
        "Dock-Snapshot",
      );
      expectChallengeUpdateShape(dockSnapshot);
      expect(dockSnapshot.event).toBeNull();
      const compositeSnapshot = await requireMessage(
        composite,
        (data) => data.type === "snapshot",
        "Composite-HUD-Snapshot",
      );
      expect(compositeSnapshot.state).toBeDefined();
      const compositeChallengeSnapshot = await requireMessage(
        composite,
        (data) => data.event === null,
        "Composite-Challenge-Snapshot",
      );
      expectChallengeUpdateShape(compositeChallengeSnapshot);

      const socketReplies = [editor, overlay, challenge, dock, composite].map((socket, index) => {
        const reply = requireMessage(
          socket,
          (data) => data.type === "time_sync",
          `Time-Sync ${String(index)}`,
        );
        socket.send(JSON.stringify({ type: "time_sync_request", clientTimestamp: index + 1 }));
        return reply;
      });
      const timeSyncs = await Promise.all(socketReplies);
      timeSyncs.forEach((reply, index) => {
        expect(reply).toEqual(
          expect.objectContaining({
            type: "time_sync",
            clientTimestamp: index + 1,
          }),
        );
        expect(typeof reply.serverTime).toBe("string");
      });

      const editorState = requireMessage(
        editor,
        (data) => data.type === "state_committed",
        "Editor-State-Broadcast",
      );
      const overlayState = requireMessage(
        overlay,
        (data) => data.type === "state_committed",
        "Overlay-State-Broadcast",
      );
      const challengeState = waitForMessage(challenge, (data) => data.type === "state_committed", 250);
      const dockState = waitForMessage(dock, (data) => data.type === "state_committed", 250);
      const compositeState = requireMessage(composite, (data) => data.type === "state_committed", "Composite-State-Broadcast");
      const { revision, overlayEnabled: _overlayEnabled, updatedAt: _updatedAt, updatedBy: _updatedBy, ...draft } = bootstrap.state;
      void [_overlayEnabled, _updatedAt, _updatedBy];
      const save = await fetchWorker("/api/state", {
        method: "PUT",
        headers: authenticatedHeaders(),
        body: JSON.stringify({
          baseRevision: revision,
          state: { ...draft, player: { ...draft.player, hpPercent: draft.player.hpPercent === 100 ? 99 : 100 } },
        }),
      });
      expect(save.status).toBe(200);
      const saved = saveResponseSchema.parse(await save.json());
      const [editorStateMessage, overlayStateMessage, compositeStateMessage] = await Promise.all([editorState, overlayState, compositeState]);
      expect(editorStateMessage).toEqual(
        expect.objectContaining({ type: "state_committed", state: saved.state }),
      );
      expect(overlayStateMessage).toEqual(
        expect.objectContaining({ type: "state_committed", state: saved.state }),
      );
      expect(compositeStateMessage).toEqual(
        expect.objectContaining({ type: "state_committed", state: saved.state }),
      );
      expect(await challengeState).toBeNull();
      expect(await dockState).toBeNull();

      const updateAfterBoard = [
        requireMessage(editor, (data) => data.event === null, "Editor-Challenge-Update-Board"),
        requireMessage(challenge, (data) => data.event === null, "Challenge-Update-Board"),
        requireMessage(dock, (data) => data.event === null, "Dock-Update-Board"),
        requireMessage(composite, (data) => data.event === null, "Composite-Update-Board"),
      ] as const;
      const overlayBoardUpdate = waitForMessage(overlay, (data) => data.event === null, 250);
      const board = await saveBoard();
      expect(board.status).toBe(200);
      const [editorBoardUpdate, challengeBoardUpdate, dockBoardUpdate, compositeBoardUpdate] = await Promise.all(updateAfterBoard);

      const boardBody = await board.json<{
        snapshot: { boardRevision: number; challenges: Array<{ id: string }> };
      }>();
      for (const message of [editorBoardUpdate, challengeBoardUpdate, dockBoardUpdate, compositeBoardUpdate]) {
        expectChallengeUpdateShape(message);
        expect(message.boardRevision).toBe(boardBody.snapshot.boardRevision);
        expect(message.event).toBeNull();
      }
      expect(await overlayBoardUpdate).toBeNull();
      const challengeId = boardBody.snapshot.challenges[0]?.id;
      if (challengeId === undefined) throw new Error("Challenge fehlt.");
      const updateAfterCommand = [
        requireMessage(editor, (data) => {
          const event = data.event as { type?: string } | null;
          return event?.type === "progressed";
        }, "Editor-Challenge-Update-Command"),
        requireMessage(challenge, (data) => {
          const event = data.event as { type?: string } | null;
          return event?.type === "progressed";
        }, "Challenge-Update-Command"),
        requireMessage(dock, (data) => {
          const event = data.event as { type?: string } | null;
          return event?.type === "progressed";
        }, "Dock-Update-Command"),
        requireMessage(composite, (data) => {
          const event = data.event as { type?: string } | null;
          return event?.type === "progressed";
        }, "Composite-Update-Command"),
      ] as const;
      const overlayCommandUpdate = waitForMessage(overlay, (data) => {
        const event = data.event as { type?: string } | null;
        return event?.type === "progressed";
      }, 250);
      const command = await fetchWorker("/api/challenges/commands", {
        method: "POST",
        headers: authenticatedHeaders(),
        body: JSON.stringify({ commandId: commandId(), scope: "challenge", type: "increment", challengeId, delta: 1 }),
      });
      expect(command.status).toBe(200);
      const [editorCommandUpdate, challengeCommandUpdate, dockCommandUpdate, compositeCommandUpdate] = await Promise.all(updateAfterCommand);
      for (const message of [editorCommandUpdate, challengeCommandUpdate, dockCommandUpdate, compositeCommandUpdate]) {
        expectChallengeUpdateShape(message);
        const event = message.event;
        expect(event).not.toBeNull();
        if (event === null || typeof event !== "object") throw new Error("Challenge-Event fehlt.");
        const eventRecord = event as Record<string, unknown>;
        expect(eventRecord.type).toBe("progressed");
        expect(eventRecord.challengeId).toBe(challengeId);
        expect(eventRecord.delta).toBe(1);
      }
      expect(await overlayCommandUpdate).toBeNull();
    } finally {
      editor.close();
      overlay.close();
      challenge.close();
      dock.close();
      composite.close();
    }
  });

  it("begrenzt Composite-Sockets auf das konfigurierte Limit", async () => {
    const overlayToken = await createOverlayToken();
    const sockets: WebSocket[] = [];
    // Eigene cf-connecting-ip: dieser Fall öffnet MAX_COMPOSITE_SOCKETS + 1
    // Verbindungen und würde sonst den Eimer der übrigen Fälle leeren.
    const clientIp = { "cf-connecting-ip": "198.51.100.91" };
    try {
      for (let index = 0; index < MAX_COMPOSITE_SOCKETS; index += 1) {
        sockets.push(
          await openSocket("/ws/composite", OVERLAY_SOCKET_PROTOCOL, overlayToken, clientIp),
        );
      }
      const rejected = await fetchWorker("/ws/composite", {
        headers: {
          ...clientIp,
          upgrade: "websocket",
          "sec-websocket-protocol": `${OVERLAY_SOCKET_PROTOCOL}, ${overlayToken}`,
        },
      });
      expect(rejected.status).toBe(429);
      expect((await rejected.json<{ error: { code: string } }>()).error.code).toBe("socket_limit");
    } finally {
      for (const socket of sockets) socket.close();
    }
  });

  it("weist über dem Limit ab, statt eine lebende Quelle zu verdrängen", async () => {
    // Die zwischenzeitliche Verdrängung erzeugte ein Karussell: die
    // hinausgeworfene Quelle verband sofort neu und warf die nächste hinaus, die
    // Anzeige verschwand im Sekundentakt. Der Fall muss deshalb das Limit
    // tatsächlich erreichen — darunter greift die Verdrängung gar nicht und ein
    // kleinerer Test wäre auch gegen den fehlerhaften Stand grün.
    const overlayToken = await createOverlayToken();
    const sockets: WebSocket[] = [];
    // Eigene cf-connecting-ip, damit die Füllung den Eimer der Nachbarfälle nicht leert.
    const clientIp = { "cf-connecting-ip": "198.51.100.92" };
    try {
      const closes: number[] = [];
      for (let index = 0; index < MAX_CHALLENGE_SOCKETS; index += 1) {
        const socket = await openSocket(
          "/ws/challenge",
          OVERLAY_SOCKET_PROTOCOL,
          overlayToken,
          clientIp,
        );
        socket.addEventListener("close", (event) => { closes.push(event.code); });
        sockets.push(socket);
      }
      const rejected = await fetchWorker("/ws/challenge", {
        headers: {
          ...clientIp,
          upgrade: "websocket",
          "sec-websocket-protocol": `${OVERLAY_SOCKET_PROTOCOL}, ${overlayToken}`,
        },
      });
      expect(rejected.status).toBe(429);
      expect((await rejected.json<{ error: { code: string } }>()).error.code).toBe("socket_limit");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(closes, "keine bestehende Quelle darf verdrängt werden").toEqual([]);

      // Ein sauber geschlossener Platz wird wieder frei.
      sockets.pop()?.close();
      sockets.push(
        await openSocket("/ws/challenge", OVERLAY_SOCKET_PROTOCOL, overlayToken, clientIp),
      );
    } finally {
      for (const socket of sockets) socket.close();
    }
  });

  it("schließt Overlay- und Challenge-Sockets bei Overlay-Token-Rotation", async () => {
    const overlayToken = await createOverlayToken();
    const challenge = await openSocket("/ws/challenge", OVERLAY_SOCKET_PROTOCOL, overlayToken);
    const overlay = await openSocket("/ws/overlay", OVERLAY_SOCKET_PROTOCOL, overlayToken);
    const composite = await openSocket("/ws/composite", OVERLAY_SOCKET_PROTOCOL, overlayToken);
    try {
      await requireMessage(challenge, (data) => data.event === null, "Challenge-Snapshot");
      await requireMessage(overlay, (data) => data.type === "snapshot", "Overlay-Snapshot");
      await requireMessage(composite, (data) => data.type === "snapshot", "Composite-HUD-Snapshot");
      await requireMessage(composite, (data) => data.event === null, "Composite-Challenge-Snapshot");
      const overlayRevoked = requireMessage(
        overlay,
        (data) => data.type === "token_revoked",
        "Overlay-Token-Widerruf",
      );
      const compositeRevoked = requireMessage(
        composite,
        (data) => data.type === "token_revoked",
        "Composite-Token-Widerruf",
      );
      const challengeRevokedMessage = requireMessage(
        challenge,
        (data) => data.type === "token_revoked",
        "Challenge-Token-Widerruf",
      );
      const closed = Promise.all([
        expectClose(challenge, 4003, "token_revoked"),
        expectClose(overlay, 4003, "token_revoked"),
        expectClose(composite, 4003, "token_revoked"),
      ]);
      const bootstrap = await refreshCsrf();
      const rotation = await fetchWorker("/api/overlay-token/rotate", {
        method: "POST",
        headers: authenticatedHeaders(),
        body: JSON.stringify({ requestId: commandId(), expectedGeneration: bootstrap.capsule.overlayToken.generation }),
      });
      expect(rotation.status).toBe(200);
      const [challengeRevokedResult, overlayRevokedMessage, compositeRevokedMessage] = await Promise.all([
        challengeRevokedMessage,
        overlayRevoked,
        compositeRevoked,
      ]);
      expect(challengeRevokedResult).toEqual({ type: "token_revoked" });
      expect(overlayRevokedMessage).toEqual({ type: "token_revoked" });
      expect(compositeRevokedMessage).toEqual({ type: "token_revoked" });
      expect(await closed).toEqual([undefined, undefined, undefined]);
    } finally {
      challenge.close();
      overlay.close();
      composite.close();
    }
  });

  it("antwortet nach einer Token-Generation-Rotation nicht mehr per time_sync", async () => {
    const overlayToken = await createOverlayToken();
    const composite = await openSocket("/ws/composite", OVERLAY_SOCKET_PROTOCOL, overlayToken);
    try {
      await requireMessage(composite, (data) => data.type === "snapshot", "Composite-HUD-Snapshot");
      await requireMessage(composite, (data) => data.event === null, "Composite-Challenge-Snapshot");

      await runInDurableObject(stub, (_instance, state) => {
        if (state.getWebSockets("composite")[0] === undefined) {
          throw new Error("Composite-Socket fehlt.");
        }
        // Der Rotations-Commit ist sichtbar, während der alte Socket noch im
        // DO-Socket-Set liegt. Genau dieses Send-time-Fenster wird hier geprüft.
        state.storage.sql.exec("UPDATE overlay_tokens SET generation = generation + 1 WHERE singleton = 1");
      });

      const reply = waitForMessage(composite, (data) => data.type === "time_sync", 250);
      composite.send(JSON.stringify({ type: "time_sync_request", clientTimestamp: 42 }));
      expect(await reply).toBeNull();
    } finally {
      composite.close();
    }
  });

  it("antwortet nach einer Token-Generation-Rotation auf dem Overlay-Socket nicht mehr per time_sync", async () => {
    const overlayToken = await createOverlayToken();
    const overlay = await openSocket("/ws/overlay", OVERLAY_SOCKET_PROTOCOL, overlayToken);
    try {
      await requireMessage(overlay, (data) => data.type === "snapshot", "Overlay-Snapshot");

      await runInDurableObject(stub, (_instance, state) => {
        if (state.getWebSockets("overlay")[0] === undefined) {
          throw new Error("Overlay-Socket fehlt.");
        }
        // Der Rotations-Commit ist sichtbar, während der alte Socket noch im
        // DO-Socket-Set liegt. Genau dieses Send-time-Fenster wird hier geprüft.
        state.storage.sql.exec("UPDATE overlay_tokens SET generation = generation + 1 WHERE singleton = 1");
      });

      const reply = waitForMessage(overlay, (data) => data.type === "time_sync", 250);
      overlay.send(JSON.stringify({ type: "time_sync_request", clientTimestamp: 42 }));
      expect(await reply).toBeNull();
    } finally {
      overlay.close();
    }
  });

  it("schließt alle Dock-Sockets bei erfolgreicher Token-Rotation", async () => {
    const dockToken = await createDockToken();
    const first = await openSocket("/ws/dock", DOCK_SOCKET_PROTOCOL, dockToken);
    const second = await openSocket("/ws/dock", DOCK_SOCKET_PROTOCOL, dockToken);
    try {
      await requireMessage(first, (data) => data.event === null, "Dock-1-Snapshot");
      await requireMessage(second, (data) => data.event === null, "Dock-2-Snapshot");
      const firstRevoked = requireMessage(first, (data) => data.type === "token_revoked", "Dock-1-Widerruf");
      const secondRevoked = requireMessage(second, (data) => data.type === "token_revoked", "Dock-2-Widerruf");
      const closed = Promise.all([
        expectClose(first, 4003, "token_revoked"),
        expectClose(second, 4003, "token_revoked"),
      ]);
      const bootstrap = await refreshCsrf();
      const requestId = commandId();
      const expectedGeneration = bootstrap.capsule.dockToken?.generation ?? 0;
      const rotation = await fetchWorker("/api/challenges/dock-token/rotate", {
        method: "POST",
        headers: authenticatedHeaders(),
        body: JSON.stringify({
          requestId,
          expectedGeneration,
        }),
      });
      expect(rotation.status).toBe(200);
      const rotated = dockTokenResponseSchema.parse(await rotation.json());
      expect(rotated.generation).toBe(expectedGeneration + 1);
      expect(await firstRevoked).toEqual({ type: "token_revoked" });
      expect(await secondRevoked).toEqual({ type: "token_revoked" });
      expect(await closed).toEqual([undefined, undefined]);
      const replacement = await openSocket("/ws/dock", DOCK_SOCKET_PROTOCOL, rotated.token);
      try {
        await requireMessage(replacement, (data) => data.event === null, "Dock-Replacement-Snapshot");
        const replay = await fetchWorker("/api/challenges/dock-token/rotate", {
          method: "POST",
          headers: authenticatedHeaders(),
          body: JSON.stringify({ requestId, expectedGeneration }),
        });
        expect(replay.status).toBe(200);
        expect(dockTokenResponseSchema.parse(await replay.json())).toEqual(rotated);
        const sync = requireMessage(replacement, (data) => data.type === "time_sync", "Dock-Replay-Time-Sync");
        replacement.send(JSON.stringify({ type: "time_sync_request", clientTimestamp: 1 }));
        expect(await sync).toEqual(
          expect.objectContaining({ type: "time_sync", clientTimestamp: 1 }),
        );
      } finally {
        replacement.close();
      }
    } finally {
      first.close();
      second.close();
    }
  });

  it("schließt Dock-Sockets auch beim Löschen und liefert danach keine Updates mehr", async () => {
    const dockToken = await createDockToken();
    const dock = await openSocket("/ws/dock", DOCK_SOCKET_PROTOCOL, dockToken);
    try {
      await requireMessage(dock, (data) => data.event === null, "Dock-Snapshot");
      const closed = expectClose(dock, 4003, "token_revoked");
      await runInDurableObject(stub, (instance) => {
        const repository = (
          instance as unknown as { challengeRepository(): { deleteDockToken(): void } }
        ).challengeRepository();
        repository.deleteDockToken();
      });
      await closed;
      const noUpdate = waitForMessage(dock, (data) => data.event === null, 250);
      const board = await saveBoard();
      expect(board.status).toBe(200);
      expect(await noUpdate).toBeNull();
    } finally {
      dock.close();
    }
  });

  it("schließt Editor-Sockets nach Ablauf von Idle- oder Absolut-Session", async () => {
    const login = await fetchWorker("/auth/dev", { redirect: "manual" });
    const expiredCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const expiredTab = "expired-socket-test";
    const expiredBootstrap = await getBootstrapFor(expiredCookie, expiredTab);
    expect(expiredBootstrap.editor.role).toBe("editor");
    const editor = await openEditorSocketFor(expiredCookie, expiredTab);
    try {
      await requireMessage(editor, (data) => data.type === "snapshot", "Abgelaufener-Editor-Snapshot");
      const sessionHash = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ session_hash: string }>("SELECT session_hash FROM editor_sessions ORDER BY rowid DESC LIMIT 1")
          .toArray()[0]?.session_hash,
      );
      expect(sessionHash).toBeDefined();
      const closed = expectClose(editor, 4001, "session_revoked");
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE editor_sessions SET idle_expires_at = ?, absolute_expires_at = ? WHERE session_hash = ?",
          "2000-01-01T00:00:00.000Z",
          "2000-01-01T00:00:00.000Z",
          sessionHash,
        );
      });
      const primaryBootstrap = await refreshCsrf();
      const { revision, overlayEnabled: _overlayEnabled, updatedAt: _updatedAt, updatedBy: _updatedBy, ...draft } = primaryBootstrap.state;
      void [_overlayEnabled, _updatedAt, _updatedBy];
      const stateBroadcast = waitForMessage(editor, (data) => data.type === "state_committed", 250);
      const save = await fetchWorker("/api/state", {
        method: "PUT",
        headers: authenticatedHeaders(),
        body: JSON.stringify({
          baseRevision: revision,
          state: { ...draft, player: { ...draft.player, hpPercent: draft.player.hpPercent === 100 ? 98 : 100 } },
        }),
      });
      expect(save.status).toBe(200);
      await closed;
      expect(await stateBroadcast).toBeNull();
    } finally {
      editor.close();
    }
  });

  it("beschränkt den Dock-Token auf Kommandos und verbietet den globalen Reset", async () => {
    const dockToken = await createDockToken();
    const deniedRoutes: Array<[string, string, string?]> = [
      ["GET", "/api/challenges"],
      ["GET", "/api/editor/bootstrap"],
      ["PUT", "/api/state", "{}"],
      ["POST", "/api/state/undo", "{}"],
      ["POST", "/api/overlay-visibility", "{}"],
      ["PUT", "/api/challenges/board", "{}"],
      ["PUT", "/api/challenges/settings", "{}"],
      ["POST", "/api/challenges/dock-token", "{}"],
      ["POST", "/api/challenges/dock-token/rotate", "{}"],
      ["POST", "/api/overlay-token/rotate", "{}"],
    ];
    for (const [method, path, body] of deniedRoutes) {
      const response = await fetchWorker(path, {
        method,
        headers: {
          authorization: `Bearer ${dockToken}`,
          origin,
          "content-type": "application/json",
        },
        body: body ?? null,
      });
      expect(response.status, path).toBe(403);
      expect((await response.json<{ error: { code: string } }>()).error.code, path).toBe("forbidden");
    }

    const board = await saveBoard();
    expect(board.status).toBe(200);
    const boardBody = await board.json<{ snapshot: { challenges: Array<{ id: string }> } }>();
    const challengeId = boardBody.snapshot.challenges[0]?.id;
    if (challengeId === undefined) throw new Error("Challenge fehlt.");
    const dock = await openSocket("/ws/dock", DOCK_SOCKET_PROTOCOL, dockToken);
    try {
      await requireMessage(dock, (data) => data.event === null, "Dock-Snapshot");
      const missingBearer = await fetchWorker("/api/challenges/commands", {
        method: "POST",
        headers: {
          "x-dock-token": dockToken,
          origin,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(missingBearer.status).toBe(401);
      expect((await missingBearer.json<{ error: { code: string } }>()).error.code).toBe("unauthorized");
      const command = await fetchWorker("/api/challenges/commands", {
        method: "POST",
        headers: { authorization: `Bearer ${dockToken}`, origin, "content-type": "application/json" },
        body: JSON.stringify({ commandId: commandId(), scope: "challenge", type: "increment", challengeId, delta: 1 }),
      });
      expect(command.status).toBe(200);
      const startChallengeTimer = await fetchWorker("/api/challenges/commands", {
        method: "POST",
        headers: { authorization: `Bearer ${dockToken}`, origin, "content-type": "application/json" },
        body: JSON.stringify({ commandId: commandId(), scope: "challenge", type: "startTimer", challengeId }),
      });
      expect(startChallengeTimer.status).toBe(200);
      const resetChallengeTimer = await fetchWorker("/api/challenges/commands", {
        method: "POST",
        headers: { authorization: `Bearer ${dockToken}`, origin, "content-type": "application/json" },
        body: JSON.stringify({ commandId: commandId(), scope: "challenge", type: "resetTimer", challengeId }),
      });
      expect(resetChallengeTimer.status).toBe(200);

      const settings = await fetchWorker("/api/challenges/settings", {
        method: "PUT",
        headers: authenticatedHeaders(),
        body: JSON.stringify({
          baseSettingsRevision: 1,
          styleId: "plain-list",
          themeMode: "inherit",
          surfaceMode: "surface",
          headerStyle: "default",
          headerTitle: "CHALLENGES",
          effectsEnabled: true,
          maxVisible: 5,
          overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end", globalTimerMode: "down",
          globalTimerTotalMs: 60_000,
          placement: { x: 300, y: 8, scale: 1 },
        }),
      });
      expect(settings.status).toBe(200);
      const start = await fetchWorker("/api/challenges/commands", {
        method: "POST",
        headers: { authorization: `Bearer ${dockToken}`, origin, "content-type": "application/json" },
        body: JSON.stringify({ commandId: commandId(), scope: "global", type: "startGlobalTimer" }),
      });
      expect(start.status).toBe(200);
      const pause = await fetchWorker("/api/challenges/commands", {
        method: "POST",
        headers: { authorization: `Bearer ${dockToken}`, origin, "content-type": "application/json" },
        body: JSON.stringify({ commandId: commandId(), scope: "global", type: "pauseGlobalTimer" }),
      });
      expect(pause.status).toBe(200);
      const reset = await fetchWorker("/api/challenges/commands", {
        method: "POST",
        headers: { authorization: `Bearer ${dockToken}`, origin, "content-type": "application/json" },
        body: JSON.stringify({ commandId: commandId(), scope: "global", type: "resetGlobalTimer" }),
      });
      expect(reset.status).toBe(403);
      expect((await reset.json<{ error: { code: string } }>()).error.code).toBe("forbidden");
    } finally {
      dock.close();
    }
  });

  it("verwirft Token-Verwechslungen auf Dock-Socket, Challenge-Socket und Kommando-Route", async () => {
    const overlayToken = await createOverlayToken();
    const dockToken = await createDockToken();
    const overlayOnDock = await fetchWorker("/ws/dock", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `${DOCK_SOCKET_PROTOCOL}, ${overlayToken}`,
        "cf-connecting-ip": "198.51.100.51",
      },
    });
    expect(overlayOnDock.status).toBe(403);
    expect((await overlayOnDock.json<{ error: { code: string } }>()).error.code).toBe("token_invalid");

    const dockOnChallenge = await fetchWorker("/ws/challenge", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `${OVERLAY_SOCKET_PROTOCOL}, ${dockToken}`,
      },
    });
    expect(dockOnChallenge.status).toBe(403);
    expect((await dockOnChallenge.json<{ error: { code: string } }>()).error.code).toBe("token_invalid");

    const commandWithoutBearer = await fetchWorker("/api/challenges/commands", {
      method: "POST",
      headers: { "x-dock-token": dockToken, origin, "content-type": "application/json" },
      body: "{}",
    });
    expect(commandWithoutBearer.status).toBe(401);
    expect((await commandWithoutBearer.json<{ error: { code: string } }>()).error.code).toBe("unauthorized");
  });

  it("liefert rate_limited auf der Dock-Kommando-Route anhand der Client-IP", async () => {
    // Das Limit ist 60/10s ohne Reserve: exakt 61 Versuche können bei einem
    // Fenster-Rollover mitten in der Schleife knapp verfehlen (Zähler setzt
    // zurück, siehe Flakiness-Report). Ein Vielfaches des Limits gibt genug
    // Puffer, dass auch ein einzelner Rollover die Prüfabsicht nicht verwässert.
    let limited: Response | null = null;
    for (let index = 0; index < 240; index += 1) {
      const response = await fetchWorker("/api/challenges/commands", {
        method: "POST",
        headers: {
          authorization: `Bearer ${formalToken(index)}`,
          origin,
          "cf-connecting-ip": "198.51.100.61",
          "content-type": "application/json",
        },
        body: "{}",
      });
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    expect(limited).not.toBeNull();
    if (limited === null) throw new Error("Dock-Kommando-Route wurde nicht rate-limited.");
    expect((await limited.json<{ error: { code: string } }>()).error.code).toBe("rate_limited");
  });

  it("liefert rate_limited beim Dock-Socket-Upgrade anhand der Client-IP", async () => {
    // Siehe Kommentar im vorigen Test: großzügiger Puffer statt exakt limit+1.
    let limited: Response | null = null;
    for (let index = 0; index < 240; index += 1) {
      const response = await fetchWorker("/ws/dock", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": `${DOCK_SOCKET_PROTOCOL}, ${formalToken(index)}`,
          "cf-connecting-ip": "198.51.100.62",
        },
      });
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    expect(limited).not.toBeNull();
    if (limited === null) throw new Error("Dock-Socket-Upgrade wurde nicht rate-limited.");
    expect((await limited.json<{ error: { code: string } }>()).error.code).toBe("rate_limited");
  });

  it("liefert rate_limited beim Overlay-Socket-Upgrade anhand der Client-IP, bevor der Kapsel-Eimer greift", async () => {
    // Die Formprüfung lässt jedes zufällige 43-Zeichen-Token durch die Tür; die
    // eigentliche Gültigkeitsprüfung passiert erst im Durable Object. Ohne
    // eigenen IP-Eimer würde eine Flut falsch geformter-aber-gültig-aussehender
    // Token den kapselweiten OVERLAY_CAPSULE_LIMITER leerräumen, bevor je ein
    // gültiges Token im Spiel war. Der IP-Eimer muss deshalb zuerst greifen.
    let limited: Response | null = null;
    let attempts = 0;
    for (let index = 0; index < capsuleLimit; index += 1) {
      attempts = index + 1;
      const response = await fetchWorker("/ws/overlay", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": `${OVERLAY_SOCKET_PROTOCOL}, ${formalToken(index)}`,
          "cf-connecting-ip": "198.51.100.71",
        },
      });
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    expect(limited).not.toBeNull();
    if (limited === null) throw new Error("Overlay-Socket-Upgrade wurde nicht rate-limited.");
    expect((await limited.json<{ error: { code: string } }>()).error.code).toBe("rate_limited");
    // Muss am eigenen Eimer greifen (plus Toleranz für einen möglichen
    // Fenster-Rollover), klar unterhalb des kapselweiten Eimers -- sonst hätte
    // die Flut bereits den globalen Eimer verbraucht. Die Budgets kommen aus
    // wrangler.jsonc, damit hier die Beziehung geprüft wird und nicht alte Zahlen.
    const tolerated = Math.floor(ipLimit * 1.5);
    expect(tolerated, "der IP-Eimer muss klar unter dem Kapsel-Eimer liegen").toBeLessThan(capsuleLimit);
    expect(attempts).toBeLessThanOrEqual(tolerated);

    // Der eigentliche Prüfzweck: die Flut von EINER IP darf eine legitime
    // Verbindung von einer ANDEREN IP nicht aussperren.
    const overlayToken = await createOverlayToken();
    const legit = await fetchWorker("/ws/overlay", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `${OVERLAY_SOCKET_PROTOCOL}, ${overlayToken}`,
        "cf-connecting-ip": "198.51.100.72",
      },
    });
    expect(legit.status).toBe(101);
    legit.webSocket?.accept();
    legit.webSocket?.close();
  });
});
