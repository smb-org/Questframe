import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/channel/migrations";
import { bootstrapResponseSchema, overlayTokenResponseSchema } from "../../src/shared/contracts/api";
import { OVERLAY_SOCKET_PROTOCOL } from "../../src/shared/contracts/protocol";

const origin = "http://localhost:5173";
const tabId = "bingo-socket-test";
const stub = env.CHANNEL.get(env.CHANNEL.idFromName(`channel:${env.BROADCASTER_ID}`));

let cookie = "";
let csrfToken = "";

type Inbox = { messages: Record<string, unknown>[] };
const inboxes = new WeakMap<WebSocket, Inbox>();

const fetchWorker = (path: string, init?: RequestInit): Promise<Response> =>
  exports.default.fetch(new Request(`http://localhost${path}`, init));

const authenticatedHeaders = (): HeadersInit => ({
  cookie,
  origin,
  "x-editor-tab": tabId,
  "x-csrf-token": csrfToken,
  "content-type": "application/json",
});

const refreshCsrf = async (): Promise<void> => {
  const response = await fetchWorker("/api/editor/bootstrap", { headers: { cookie, "x-editor-tab": tabId } });
  csrfToken = bootstrapResponseSchema.parse(await response.json()).csrfToken;
};

const createOverlayToken = async (): Promise<string> => {
  const bootstrap = bootstrapResponseSchema.parse(await (await fetchWorker("/api/editor/bootstrap", {
    headers: { cookie, "x-editor-tab": tabId },
  })).json());
  const response = await fetchWorker("/api/overlay-token", {
    method: "POST",
    headers: authenticatedHeaders(),
    body: JSON.stringify({ requestId: crypto.randomUUID(), expectedGeneration: bootstrap.capsule.overlayToken.generation }),
  });
  return overlayTokenResponseSchema.parse(await response.json()).token;
};

const listen = (socket: WebSocket): void => {
  const inbox = { messages: [] as Record<string, unknown>[] };
  inboxes.set(socket, inbox);
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    try {
      inbox.messages.push(JSON.parse(event.data) as Record<string, unknown>);
    } catch {
      return;
    }
  });
};

const openSocket = async (path: string, token?: string): Promise<WebSocket> => {
  const headers = new Headers({ upgrade: "websocket" });
  if (token === undefined) {
    headers.set("cookie", cookie);
    headers.set("x-editor-tab", tabId);
  } else {
    headers.set("sec-websocket-protocol", `${OVERLAY_SOCKET_PROTOCOL}, ${token}`);
  }
  const response = await fetchWorker(path, { headers });
  expect(response.status, path).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error(`WebSocket für ${path} fehlt.`);
  socket.accept();
  listen(socket);
  return socket;
};

const waitForMessage = async (
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 1_000,
): Promise<Record<string, unknown> | null> => {
  const inbox = inboxes.get(socket);
  if (inbox === undefined) return null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const index = inbox.messages.findIndex(predicate);
    if (index >= 0) return inbox.messages.splice(index, 1)[0] ?? null;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
};

const requireBingoUpdate = async (socket: WebSocket): Promise<Record<string, unknown>> => {
  const message = await waitForMessage(socket, (value) => value.type === "bingo_update");
  expect(message).not.toBeNull();
  if (message === null) throw new Error("Bingo-Update fehlt.");
  return message;
};

const noBingoUpdate = async (socket: WebSocket): Promise<void> => {
  expect(await waitForMessage(socket, (value) => value.type === "bingo_update", 50)).toBeNull();
};

describe("Bingo-Sockets", () => {
  beforeAll(async () => {
    const login = await fetchWorker("/auth/dev", { redirect: "manual" });
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  });

  beforeEach(async () => {
    await runInDurableObject(stub, (_instance, state) => {
      runMigrations(state.storage.sql, "worker-test-bingo-sockets");
      for (const tag of ["editor", "overlay", "composite", "challenge", "dock", "bingo"] as const) {
        for (const socket of state.getWebSockets(tag)) socket.close();
      }
      state.storage.sql.exec("DELETE FROM state_history WHERE module_id = 'bingo'");
      state.storage.sql.exec("DELETE FROM overlay_tokens");
      state.storage.sql.exec(
        `UPDATE bg_board SET marks_json = '[]', card_revision = 0, mark_revision = 0,
          generation = 0, style = 'marker', placement_x = 8, placement_y = 8, placement_scale = 1
         WHERE singleton = 1`,
      );
    });
    await refreshCsrf();
  });

  it("sends ceremony-free snapshots, broadcasts one completed line, stays silent on retries, and undoes without ceremony", async () => {
    const token = await createOverlayToken();
    const bingo = await openSocket("/ws/bingo", token);
    const editor = await openSocket(`/ws/editor?tab=${tabId}`);
    const composite = await openSocket("/ws/composite", token);
    try {
      const initialBingo = await requireBingoUpdate(bingo);
      expect(initialBingo.ceremony).toBeUndefined();
      const editorSnapshot = await waitForMessage(editor, (value) => value.type === "snapshot");
      expect(editorSnapshot?.state).toMatchObject({ compositeBingoVisible: false });
      expect((await requireBingoUpdate(editor)).ceremony).toBeUndefined();
      const compositeSnapshot = await waitForMessage(composite, (value) => value.type === "snapshot");
      expect(compositeSnapshot?.state).toMatchObject({ compositeBingoVisible: false });
      expect((await requireBingoUpdate(composite)).ceremony).toBeUndefined();

      const card = {
        title: "Socket-Bingo",
        size: 3,
        cells: Array.from({ length: 9 }, (_, index) => ({ id: `socket-${String(index)}`, text: `Feld ${String(index)}` })),
      };
      const saved = await fetchWorker("/api/bingo/board", {
        method: "PUT",
        headers: authenticatedHeaders(),
        body: JSON.stringify({ ...card, expectedCardRevision: 0 }),
      });
      expect(saved.status).toBe(200);
      await Promise.all([requireBingoUpdate(bingo), requireBingoUpdate(editor), requireBingoUpdate(composite)]);

      for (const index of [0, 1]) {
        const response = await fetchWorker("/api/bingo/mark", {
          method: "POST",
          headers: authenticatedHeaders(),
          body: JSON.stringify({ cellId: `socket-${String(index)}`, marked: true, expectedMarkRevision: index + 1 }),
        });
        expect(response.status).toBe(200);
        await Promise.all([requireBingoUpdate(bingo), requireBingoUpdate(editor), requireBingoUpdate(composite)]);
      }
      const completed = await fetchWorker("/api/bingo/mark", {
        method: "POST",
        headers: authenticatedHeaders(),
        body: JSON.stringify({ cellId: "socket-2", marked: true, expectedMarkRevision: 3 }),
      });
      expect(completed.status).toBe(200);
      const updates = await Promise.all([requireBingoUpdate(bingo), requireBingoUpdate(editor), requireBingoUpdate(composite)]);
      for (const update of updates) expect(update.ceremony).toEqual({ lines: [{ kind: "row", index: 0 }], fullCard: false });

      const repeated = await fetchWorker("/api/bingo/mark", {
        method: "POST",
        headers: authenticatedHeaders(),
        body: JSON.stringify({ cellId: "socket-2", marked: true, expectedMarkRevision: 3 }),
      });
      expect(repeated.status).toBe(200);
      await Promise.all([noBingoUpdate(bingo), noBingoUpdate(editor), noBingoUpdate(composite)]);

      const board = await (await fetchWorker("/api/bingo", { headers: authenticatedHeaders() })).json<{
        cardRevision: number;
        markRevision: number;
        generation: number;
        style: "marker" | "broadcast";
      }>();
      const history = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ channel_seq: number }>(
          "SELECT channel_seq FROM state_history WHERE module_id = 'bingo' ORDER BY channel_seq DESC LIMIT 1",
        ).toArray()[0]?.channel_seq,
      );
      if (history === undefined) throw new Error("Bingo-Historie fehlt.");
      const undone = await fetchWorker("/api/state/undo", {
        method: "POST",
        headers: authenticatedHeaders(),
        body: JSON.stringify({
          moduleId: "bingo",
          channelSeq: history,
          baseCardRevision: board.cardRevision,
          baseMarkRevision: board.markRevision,
          baseGeneration: board.generation,
          baseStyle: board.style,
        }),
      });
      expect(undone.status).toBe(200);
      for (const update of await Promise.all([requireBingoUpdate(bingo), requireBingoUpdate(editor), requireBingoUpdate(composite)])) {
        expect(update.ceremony).toBeUndefined();
      }
    } finally {
      bingo.close();
      editor.close();
      composite.close();
    }
  });
});
