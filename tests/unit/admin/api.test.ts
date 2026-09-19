import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminApiError, BrowserAdminApi } from "../../../src/admin/api";
import type { Command } from "../../../src/modules/win-challenges/contracts/schemas";
import {
  createDefaultState,
  getReleaseCapabilities,
  twitchUserIdSchema,
} from "../../../src/shared/contracts/state";

const actor = {
  twitchUserId: twitchUserIdSchema.parse("12345678901234567890"),
  displayName: "Moderator",
};
const now = "2026-08-29T12:00:00.000Z";

const state = () => createDefaultState(actor, now);
const bootstrap = () => ({
  capsule: {
    id: "irl-stream-hud",
    name: "Beispielkanal",
    timezone: "Europe/Berlin",
    limits: {
      maxGuests: 5 as const,
      maxActiveEffects: 8 as const,
      maxEditorSockets: 10 as const,
      maxOverlaySockets: 10 as const,
      maxMediaBytes: 8_388_608 as const,
    },
    overlayToken: {
      exists: false,
      generation: 0,
      createdAt: null,
      lastUsedAt: null,
      connectedSockets: 0,
      token: null,
    },
  },
  capabilities: getReleaseCapabilities("v1b"),
  editor: { ...actor, role: "editor" as const },
  state: state(),
  recentAudit: [],
  undoTargets: [],
  challengeUndoTargets: [],
  csrfToken: "csrf-token-with-enough-entropy",
  serverTime: now,
});

const auditEntry = {
  id: "audit-1",
  revision: 2,
  action: "save" as const,
  actor,
  summary: "Gespeichert",
  createdAt: now,
};

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: Event & { data?: unknown }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, callback: (event: Event & { data?: unknown }) => void) {
    const current = this.listeners.get(type) ?? [];
    current.push(callback);
    this.listeners.set(type, current);
  }

  emit(type: string, data?: unknown) {
    for (const callback of this.listeners.get(type) ?? []) {
      callback({ type, data } as Event & { data?: unknown });
    }
  }

  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("BrowserAdminApi", () => {
  it("behält die Bindung bei gelösten Challenge-Methoden", async () => {
    const summary = {
      id: "set-1",
      type: "user" as const,
      name: "Mein Set",
      hasProgress: false,
      createdAt: now,
      updatedAt: now,
    };
    const set = {
      schemaVersion: 1 as const,
      name: "Mein Set",
      createdAt: now,
      challenges: [],
    };
    const challengeSnapshot = {
      eventSeq: 0,
      boardRevision: 1,
      settingsRevision: 1,
      settings: {
        styleId: "plain-list" as const,
        themeMode: "own" as const,
        surfaceOpacity: 100,
        headerStyle: "default" as const,
        textEmphasis: "auto" as const,
        fontFamily: "theme" as const,
        fontScale: 1,
        headerTitle: "CHALLENGES",
        penaltyLabel: "STRAFE",
        penaltyText: "",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut" as const,
        overflowTempo: "medium" as const,
        numbered: false,
        keyVisible: false,
        doneOrder: "end" as const,
        globalTimerMode: "down" as const,
        globalTimer: null,
        placement: { x: 300, y: 8, scale: 1 },
      },
      challenges: [],
    };
    const response = {
      list: { sets: [summary] },
      set: { summary, set },
      board: { snapshot: challengeSnapshot, createdIds: {} },
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(response.list))
      .mockResolvedValueOnce(Response.json(response.set))
      .mockResolvedValueOnce(Response.json(response.set))
      .mockResolvedValueOnce(Response.json(response.board));
    vi.stubGlobal("fetch", fetcher);
    const api = new BrowserAdminApi();
    const listChallengeSets = api.listChallengeSets;
    const getChallengeSet = api.getChallengeSet;
    const saveChallengeSet = api.saveChallengeSet;
    const saveChallengeBoard = api.saveChallengeBoard;

    await expect(Promise.all([
      listChallengeSets(),
      getChallengeSet("set-1"),
      saveChallengeSet({ name: "Mein Set", includeProgress: false }),
      saveChallengeBoard({ baseBoardRevision: 1, challenges: [] }),
    ])).resolves.toEqual([response.list, response.set, response.set, response.board]);
  });

  it("sends session challenge commands with the editor tab, CSRF token, and UUID command", async () => {
    const command: Command = {
      commandId: "dc95708a-645a-4bc0-9ca3-7ffbd42e6662",
      scope: "global",
      type: "resetGlobalTimer",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(bootstrap()))
      .mockResolvedValueOnce(Response.json({ eventSeq: 4, replayed: false, settings: undefined }));
    vi.stubGlobal("fetch", fetcher);
    const api = new BrowserAdminApi();

    await api.bootstrap();
    await expect(api.sendChallengeCommand(command)).resolves.toMatchObject({ eventSeq: 4, replayed: false });

    const requestCall = fetcher.mock.calls[1];
    if (requestCall === undefined) throw new Error("Command-Request wurde nicht gesendet.");
    const [input, init] = requestCall;
    const request = new Request(typeof input === "string" ? new URL(input, "https://example.test") : input, init);
    expect(request.url).toContain("/api/challenges/commands");
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-editor-tab")).toMatch(/[0-9a-f-]+/u);
    expect(request.headers.get("x-csrf-token")).toBe(bootstrap().csrfToken);
    expect(await request.json()).toEqual(command);
  });

  it("persists one tab ID, bootstraps CSRF and attaches it only to mutations", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(bootstrap()))
      .mockResolvedValueOnce(Response.json({
        state: { ...state(), revision: 2 },
        auditEntry,
        undoTargets: [],
        serverTime: now,
      }));
    vi.stubGlobal("fetch", fetcher);

    const api = new BrowserAdminApi();
    await expect(api.bootstrap()).resolves.toMatchObject({ csrfToken: bootstrap().csrfToken });
    const current = state();
    const { revision, overlayEnabled, updatedAt, updatedBy, ...draft } = current;
    await api.save({ baseRevision: revision, state: draft });
    expect([overlayEnabled, updatedAt, updatedBy]).toHaveLength(3);

    const bootstrapRequest = new Request("https://example.test", fetcher.mock.calls[0]?.[1]);
    const saveRequest = new Request("https://example.test", fetcher.mock.calls[1]?.[1]);
    expect(bootstrapRequest.headers.get("x-editor-tab")).toMatch(/[0-9a-f-]+/u);
    expect(bootstrapRequest.headers.get("x-csrf-token")).toBeNull();
    expect(saveRequest.headers.get("x-csrf-token")).toBe(bootstrap().csrfToken);
    expect(saveRequest.credentials).toBe("same-origin");

    const second = new BrowserAdminApi();
    expect(sessionStorage.getItem("irl-stream-hud-editor-tab")).toBe(
      new Request("https://example.test", fetcher.mock.calls[0]?.[1]).headers.get("x-editor-tab"),
    );
    expect(second).toBeInstanceOf(BrowserAdminApi);
  });

  it("covers visibility, undo, token, upload, lookup, revalidation and logout contracts", async () => {
    const visibility = { state: state(), auditEntry: null, undoTargets: [], serverTime: now };
    const saveResponse = { state: state(), auditEntry, undoTargets: [], serverTime: now };
    const tokenResponse = {
      requestId: "dc95708a-645a-4bc0-9ca3-7ffbd42e6662",
      generation: 1,
      fingerprint: "ABCDEF12",
      createdAt: now,
      token: "A".repeat(43),
    };
    const uploaded = {
      portrait: { kind: "uploaded" as const, contentHash: "a".repeat(64) },
      width: 64,
      height: 64,
      byteLength: 20,
      leaseExpiresAt: now,
    };
    const guest = {
      user: {
        id: "99999999999999999999",
        login: "gast_tv",
        displayName: "GastTV",
        profileImageUrl: "https://example.test/gast.png",
      },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ csrfToken: "a-new-csrf-token-value" }))
      .mockResolvedValueOnce(Response.json(visibility))
      .mockResolvedValueOnce(Response.json(saveResponse))
      .mockResolvedValueOnce(Response.json(tokenResponse))
      .mockResolvedValueOnce(Response.json(tokenResponse))
      .mockResolvedValueOnce(Response.json(uploaded))
      .mockResolvedValueOnce(Response.json(guest))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const api = new BrowserAdminApi();

    await api.revalidate();
    await expect(api.setVisibility(false)).resolves.toEqual(visibility);
    await expect(api.undo("hud", 1, 2)).resolves.toEqual(saveResponse);
    await expect(api.mutateOverlayToken(false, {
      requestId: tokenResponse.requestId,
      expectedGeneration: 0,
    })).resolves.toEqual(tokenResponse);
    await expect(api.mutateOverlayToken(true, {
      requestId: tokenResponse.requestId,
      expectedGeneration: 0,
    })).resolves.toEqual(tokenResponse);
    await expect(api.uploadPortrait(new Blob(["webp"], { type: "image/webp" }))).resolves.toEqual(uploaded.portrait);
    await expect(api.lookupTwitchUser("Gast TV")).resolves.toEqual(guest.user);
    await api.logout();

    expect(fetcher.mock.calls.map(([url]) =>
      url instanceof Request ? url.url : url instanceof URL ? url.href : url,
    )).toEqual([
      "/api/auth/revalidate",
      "/api/overlay-visibility",
      "/api/state/undo",
      "/api/overlay-token",
      "/api/overlay-token/rotate",
      "/api/media",
      "/api/twitch/users?login=Gast%20TV",
      "/auth/logout",
    ]);
    expect(localStorage.length).toBe(0);
  });

  it("sendet beim Challenge-Undo alle drei Konfliktrevisionen und parst die Modulliste", async () => {
    const challengeSnapshot = {
      eventSeq: 6,
      boardRevision: 4,
      settingsRevision: 5,
      settings: {
        styleId: "plain-list",
        themeMode: "own",
        surfaceOpacity: 100,
        headerStyle: "default",
        textEmphasis: "auto",
        fontFamily: "theme",
        fontScale: 1,
        headerTitle: "CHALLENGES",
        penaltyLabel: "STRAFE",
        penaltyText: "",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut",
        overflowTempo: "medium",
        numbered: false,
        keyVisible: false,
        doneOrder: "end",
        globalTimerMode: "down",
        globalTimer: null,
        placement: { x: 300, y: 8, scale: 1 },
      },
      challenges: [],
    } as const;
    const undoTargets = [{
      channelSeq: 7,
      moduleId: "challenges" as const,
      createdAt: now,
      summary: "Challenge-Board gespeichert",
    }];
    const response = { snapshot: challengeSnapshot, undoTargets, serverTime: now };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(response));
    vi.stubGlobal("fetch", fetcher);
    const api = new BrowserAdminApi();

    await expect(api.undo("challenges", 7, {
      boardRevision: 4,
      settingsRevision: 5,
      eventSeq: 6,
    })).resolves.toEqual(response);

    const request = new Request("https://example.test", fetcher.mock.calls[0]?.[1]);
    expect(await request.json()).toEqual({
      moduleId: "challenges",
      channelSeq: 7,
      baseBoardRevision: 4,
      baseSettingsRevision: 5,
      baseEventSeq: 6,
    });
  });

  it("rebootstraps and retries a mutation exactly once after CSRF expiry", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: "csrf_invalid", message: "Abgelaufen" } }, { status: 403 }))
      .mockResolvedValueOnce(Response.json(bootstrap()))
      .mockResolvedValueOnce(Response.json({ state: state(), auditEntry: null, undoTargets: [], serverTime: now }));
    vi.stubGlobal("fetch", fetcher);

    const api = new BrowserAdminApi();
    await expect(api.setVisibility(true)).resolves.toMatchObject({ state: { overlayEnabled: true } });
    const retry = new Request("https://example.test", fetcher.mock.calls[2]?.[1]);
    expect(retry.headers.get("x-csrf-token")).toBe(bootstrap().csrfToken);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("returns stable structured and opaque errors without leaking response bodies", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        error: { code: "revision_conflict", message: "Neuer Stand", currentRevision: 7 },
      }, { status: 409 }))
      .mockResolvedValueOnce(new Response("raw upstream secret", { status: 502 }));
    vi.stubGlobal("fetch", fetcher);
    const api = new BrowserAdminApi();

    await expect(api.setVisibility(false)).rejects.toMatchObject({
      name: "AdminApiError",
      status: 409,
      code: "revision_conflict",
      message: "Neuer Stand",
      currentRevision: 7,
    });
    await expect(api.setVisibility(false)).rejects.toMatchObject({
      status: 502,
      code: "request_failed",
      message: "Anfrage fehlgeschlagen (502).",
    });
    expect(new AdminApiError(400, "bad_request", "Falsch").currentRevision).toBeUndefined();
  });

  it("publishes valid editor snapshots, audit entries and history changes, then reconnects with bounded backoff", () => {
    vi.useFakeTimers();
    const onState = vi.fn();
    const onOnlineChange = vi.fn();
    const onOverlayPresence = vi.fn();
    const onAudit = vi.fn();
    const onUndoTargets = vi.fn();
    const api = new BrowserAdminApi();
    const dispose = api.subscribe({ onState, onOnlineChange, onOverlayPresence, onAudit, onUndoTargets });
    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toContain("/ws/editor?tab=");

    socket?.emit("open");
    socket?.emit("message", new Blob());
    socket?.emit("message", "not-json");
    const undoTargets = [{
      channelSeq: 1,
      moduleId: "hud" as const,
      createdAt: now,
      summary: "Startzustand",
    }];
    socket?.emit("message", JSON.stringify({ type: "history_changed", moduleId: "challenges", undoTargets }));
    socket?.emit("message", JSON.stringify({ type: "audit_appended", moduleId: "hud", entry: auditEntry, undoTargets }));
    socket?.emit("message", JSON.stringify({ type: "snapshot", state: state() }));
    socket?.emit("message", JSON.stringify({ type: "overlay_presence", connectedSockets: 1 }));
    expect(onOnlineChange).toHaveBeenCalledWith(true);
    expect(onUndoTargets).toHaveBeenCalledWith("challenges", undoTargets);
    expect(onAudit).toHaveBeenCalledWith(auditEntry, "hud", undoTargets);
    expect(onState).toHaveBeenCalledWith(state());
    expect(onOverlayPresence).toHaveBeenCalledWith(1);

    socket?.emit("close");
    expect(onOnlineChange).toHaveBeenCalledWith(false);
    vi.advanceTimersByTime(750);
    expect(FakeWebSocket.instances).toHaveLength(2);
    dispose();
    expect(FakeWebSocket.instances[1]?.closed).toBe(true);
    FakeWebSocket.instances[1]?.emit("close");
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
