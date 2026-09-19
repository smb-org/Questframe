import {
  apiErrorSchema,
  bootstrapResponseSchema,
  dockTokenResponseSchema,
  flushDisplaySocketsResponseSchema,
  overlayTokenResponseSchema,
  renewMediaLeasesResponseSchema,
  saveResponseSchema,
  serverMessageSchema,
  twitchLookupResponseSchema,
  uploadResponseSchema,
  visibilityResponseSchema,
  type ChallengeUndoBaseRevisions,
  type UndoModuleId,
  type BootstrapResponse,
  type SaveRequest,
  type SaveResponse,
} from "../shared/contracts/api";
import {
  boardSaveRequestSchema,
  boardSaveResponseSchema,
  challengeBoardSnapshotSchema,
  challengeSetDeleteResponseSchema,
  challengeSetListResponseSchema,
  challengeSetResponseSchema,
  challengeSetSaveRequestSchema,
  commandResponseSchema,
  challengeUndoResponseSchema,
  settingsSaveRequestSchema,
  settingsSaveResponseSchema,
  type BoardSaveRequest,
  type BoardSaveResponse,
  type ChallengeBoardSnapshot,
  type ChallengeSetResponse,
  type ChallengeSetListResponse,
  type ChallengeSetSaveRequest,
  type Command,
  type CommandResponse,
  type ChallengeUndoResponse,
  type SettingsSaveRequest,
  type SettingsSaveResponse,
} from "../modules/win-challenges/contracts/schemas";
import { parseChallengeUpdate } from "../challenges/wire";
import { startSocketHeartbeat } from "../shared/reconnect";
import type { AdminApi } from "./AdminWorkspace";

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly currentRevision?: number;
  readonly currentSnapshot?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    currentRevision?: number,
    currentSnapshot?: unknown,
  ) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
    if (currentRevision !== undefined) this.currentRevision = currentRevision;
    if (currentSnapshot !== undefined) this.currentSnapshot = currentSnapshot;
  }
}

const getTabId = (): string => {
  const existing = sessionStorage.getItem("irl-stream-hud-editor-tab");
  if (existing !== null) return existing;
  const value = crypto.randomUUID();
  sessionStorage.setItem("irl-stream-hud-editor-tab", value);
  return value;
};

export class BrowserAdminApi implements AdminApi {
  private readonly tabId = getTabId();
  private csrfToken = "";

  async bootstrap(): Promise<BootstrapResponse> {
    const response = await this.request("/api/editor/bootstrap", { method: "GET" }, false);
    const parsed = bootstrapResponseSchema.parse(await response.json());
    this.csrfToken = parsed.csrfToken;
    return parsed;
  }

  async revalidate(): Promise<void> {
    const response = await this.request(
      "/api/auth/revalidate",
      { method: "POST", body: "{}" },
      false,
    );
    const body = await response.json<{ csrfToken?: unknown }>();
    if (typeof body.csrfToken === "string") this.csrfToken = body.csrfToken;
  }

  async logout(): Promise<void> {
    await this.request(
      "/auth/logout",
      { method: "POST", body: "{}" },
      true,
    );
  }

  async save(input: SaveRequest) {
    const response = await this.requestJson("/api/state", "PUT", input);
    return saveResponseSchema.parse(await response.json());
  }

  async setVisibility(enabled: boolean) {
    const response = await this.requestJson("/api/overlay-visibility", "POST", { enabled });
    return visibilityResponseSchema.parse(await response.json());
  }

  async getChallengeBoard(): Promise<ChallengeBoardSnapshot> {
    const response = await this.request("/api/challenges", { method: "GET" }, false);
    return challengeBoardSnapshotSchema.parse(await response.json());
  }

  async saveChallengeBoard(input: BoardSaveRequest): Promise<BoardSaveResponse> {
    const request = boardSaveRequestSchema.parse(input);
    const response = await this.requestJson("/api/challenges/board", "PUT", request);
    return boardSaveResponseSchema.parse(await response.json());
  }

  async listChallengeSets(): Promise<ChallengeSetListResponse> {
    const response = await this.request("/api/challenges/sets", { method: "GET" }, false);
    return challengeSetListResponseSchema.parse(await response.json());
  }

  async getChallengeSet(setId: string): Promise<ChallengeSetResponse> {
    const response = await this.request(`/api/challenges/sets/${encodeURIComponent(setId)}`, { method: "GET" }, false);
    return challengeSetResponseSchema.parse(await response.json());
  }

  async saveChallengeSet(input: ChallengeSetSaveRequest): Promise<ChallengeSetResponse> {
    const request = challengeSetSaveRequestSchema.parse(input);
    const response = await this.requestJson("/api/challenges/sets", "POST", request);
    return challengeSetResponseSchema.parse(await response.json());
  }

  async deleteChallengeSet(setId: string): Promise<string> {
    const response = await this.request(`/api/challenges/sets/${encodeURIComponent(setId)}`, { method: "DELETE" }, true);
    return challengeSetDeleteResponseSchema.parse(await response.json()).id;
  }

  async saveChallengeSettings(input: SettingsSaveRequest): Promise<SettingsSaveResponse> {
    const request = settingsSaveRequestSchema.parse(input);
    const response = await this.requestJson("/api/challenges/settings", "PUT", request);
    return settingsSaveResponseSchema.parse(await response.json());
  }

  async sendChallengeCommand(command: Command): Promise<CommandResponse> {
    const response = await this.requestJson("/api/challenges/commands", "POST", command);
    return commandResponseSchema.parse(await response.json());
  }

  async undo(moduleId: "hud", channelSeq: number, baseRevision: number): Promise<SaveResponse>;
  async undo(moduleId: "challenges", channelSeq: number, baseRevision: ChallengeUndoBaseRevisions): Promise<ChallengeUndoResponse>;
  async undo(moduleId: UndoModuleId, channelSeq: number, baseRevision: number | ChallengeUndoBaseRevisions) {
    if (moduleId === "hud") {
      if (typeof baseRevision !== "number") throw new Error("HUD-Undo benötigt eine HUD-Revision.");
      const response = await this.requestJson("/api/state/undo", "POST", { moduleId, channelSeq, baseRevision });
      return saveResponseSchema.parse(await response.json());
    }
    if (typeof baseRevision === "number") throw new Error("Challenge-Undo benötigt drei Konfliktrevisionen.");
    const response = await this.requestJson("/api/state/undo", "POST", {
      moduleId,
      channelSeq,
      baseBoardRevision: baseRevision.boardRevision,
      baseSettingsRevision: baseRevision.settingsRevision,
      baseEventSeq: baseRevision.eventSeq,
    });
    return challengeUndoResponseSchema.parse(await response.json());
  }

  async mutateOverlayToken(
    rotate: boolean,
    input: { requestId: string; expectedGeneration: number },
  ) {
    const response = await this.requestJson(
      rotate ? "/api/overlay-token/rotate" : "/api/overlay-token",
      "POST",
      input,
    );
    return overlayTokenResponseSchema.parse(await response.json());
  }

  async mutateDockToken(
    rotate: boolean,
    input: { requestId: string; expectedGeneration: number },
  ) {
    const response = await this.requestJson(
      rotate ? "/api/challenges/dock-token/rotate" : "/api/challenges/dock-token",
      "POST",
      input,
    );
    return dockTokenResponseSchema.parse(await response.json());
  }

  async flushDisplaySockets() {
    const response = await this.requestJson("/api/sockets/flush", "POST", {});
    return flushDisplaySocketsResponseSchema.parse(await response.json());
  }

  async uploadPortrait(blob: Blob) {
    const response = await this.request(
      "/api/media",
      {
        method: "POST",
        headers: { "content-type": "image/webp" },
        body: blob,
      },
      true,
    );
    return uploadResponseSchema.parse(await response.json()).portrait;
  }

  async renewMediaLeases(contentHashes: string[]) {
    const response = await this.requestJson("/api/media/leases/renew", "POST", {
      contentHashes,
    });
    renewMediaLeasesResponseSchema.parse(await response.json());
  }

  async lookupTwitchUser(login: string) {
    const response = await this.request(
      `/api/twitch/users?login=${encodeURIComponent(login)}`,
      { method: "GET" },
      false,
    );
    return twitchLookupResponseSchema.parse(await response.json()).user;
  }

  subscribe(callbacks: {
    onState: Parameters<NonNullable<AdminApi["subscribe"]>>[0]["onState"];
    onOnlineChange: Parameters<NonNullable<AdminApi["subscribe"]>>[0]["onOnlineChange"];
    onOverlayPresence: Parameters<NonNullable<AdminApi["subscribe"]>>[0]["onOverlayPresence"];
    onAudit: Parameters<NonNullable<AdminApi["subscribe"]>>[0]["onAudit"];
    onUndoTargets: Parameters<NonNullable<AdminApi["subscribe"]>>[0]["onUndoTargets"];
    onChallengeUpdate?: Parameters<NonNullable<AdminApi["subscribe"]>>[0]["onChallengeUpdate"];
  }): () => void {
    let disposed = false;
    let socket: WebSocket | null = null;
    let stopHeartbeat: (() => void) | null = null;
    let timer: number | null = null;
    let attempt = 0;
    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(
        `${protocol}//${window.location.host}/ws/editor?tab=${encodeURIComponent(this.tabId)}`,
      );
      socket.addEventListener("open", () => {
        stopHeartbeat?.();
        stopHeartbeat = startSocketHeartbeat(socket as WebSocket);
        attempt = 0;
        callbacks.onOnlineChange(true);
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let input: unknown;
        try {
          input = JSON.parse(event.data) as unknown;
        } catch {
          return;
        }
        const challengeUpdate = parseChallengeUpdate(input);
        if (challengeUpdate !== null) {
          callbacks.onChallengeUpdate?.(challengeUpdate);
          return;
        }
        const message = serverMessageSchema.safeParse(input);
        if (!message.success) return;
        if (message.data.type === "snapshot" || message.data.type === "state_committed") {
          callbacks.onState(message.data.state);
        } else if (message.data.type === "audit_appended") {
          callbacks.onAudit(message.data.entry, message.data.moduleId, message.data.undoTargets);
        } else if (message.data.type === "history_changed") {
          callbacks.onUndoTargets(message.data.moduleId, message.data.undoTargets);
        } else if (message.data.type === "overlay_presence") {
          callbacks.onOverlayPresence(message.data.connectedSockets);
        }
      });
      socket.addEventListener("close", () => {
        stopHeartbeat?.();
        stopHeartbeat = null;
        if (disposed) return;
        callbacks.onOnlineChange(false);
        const delay = Math.min(30_000, 750 * 2 ** attempt);
        attempt += 1;
        timer = window.setTimeout(connect, delay);
      });
    };
    connect();
    return () => {
      disposed = true;
      stopHeartbeat?.();
      stopHeartbeat = null;
      if (timer !== null) window.clearTimeout(timer);
      socket?.close();
    };
  }

  private requestJson(path: string, method: string, value: unknown): Promise<Response> {
    return this.request(
      path,
      {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      },
      true,
    );
  }

  private async request(path: string, init: RequestInit, mutation: boolean): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("x-editor-tab", this.tabId);
    if (mutation && this.csrfToken !== "") headers.set("x-csrf-token", this.csrfToken);
    const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
    if (response.ok) return response;
    let code = "request_failed";
    let message = `Anfrage fehlgeschlagen (${String(response.status)}).`;
    let currentRevision: number | undefined;
    let currentSnapshot: unknown;
    try {
      const parsed = apiErrorSchema.parse(await response.clone().json());
      code = parsed.error.code;
      message = parsed.error.message;
      currentRevision = parsed.error.currentRevision;
      currentSnapshot = parsed.error.currentSnapshot;
    } catch {
      // The public fallback above intentionally excludes raw response details.
    }
    if (mutation && code === "csrf_invalid") {
      const bootstrap = await this.bootstrap();
      this.csrfToken = bootstrap.csrfToken;
      const retryHeaders = new Headers(init.headers);
      retryHeaders.set("x-editor-tab", this.tabId);
      retryHeaders.set("x-csrf-token", this.csrfToken);
      const retry = await fetch(path, {
        ...init,
        headers: retryHeaders,
        credentials: "same-origin",
      });
      if (retry.ok) return retry;
    }
    throw new AdminApiError(response.status, code, message, currentRevision, currentSnapshot);
  }
}
