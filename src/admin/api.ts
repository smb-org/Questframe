import {
  apiErrorSchema,
  bootstrapResponseSchema,
  overlayTokenResponseSchema,
  renewMediaLeasesResponseSchema,
  saveResponseSchema,
  serverMessageSchema,
  twitchLookupResponseSchema,
  uploadResponseSchema,
  visibilityResponseSchema,
  type BootstrapResponse,
  type SaveRequest,
} from "../shared/contracts/api";
import type { AdminApi } from "./AdminWorkspace";

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly currentRevision?: number;

  constructor(status: number, code: string, message: string, currentRevision?: number) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
    if (currentRevision !== undefined) this.currentRevision = currentRevision;
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
    sessionStorage.removeItem("irl-stream-hud-obs-url");
    sessionStorage.removeItem("irl-stream-hud-pending-token");
  }

  async save(input: SaveRequest) {
    const response = await this.requestJson("/api/state", "PUT", input);
    return saveResponseSchema.parse(await response.json());
  }

  async setVisibility(enabled: boolean) {
    const response = await this.requestJson("/api/overlay-visibility", "POST", { enabled });
    return visibilityResponseSchema.parse(await response.json());
  }

  async undo(baseRevision: number, targetRevision: number) {
    const response = await this.requestJson("/api/state/undo", "POST", {
      baseRevision,
      targetRevision,
    });
    return saveResponseSchema.parse(await response.json());
  }

  async mutateOverlayToken(
    rotate: boolean,
    input: { requestId: string; expectedGeneration: number; candidateToken: string },
  ) {
    const response = await this.requestJson(
      rotate ? "/api/overlay-token/rotate" : "/api/overlay-token",
      "POST",
      input,
    );
    return overlayTokenResponseSchema.parse(await response.json());
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
  }): () => void {
    let disposed = false;
    let socket: WebSocket | null = null;
    let timer: number | null = null;
    let attempt = 0;
    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(
        `${protocol}//${window.location.host}/ws/editor?tab=${encodeURIComponent(this.tabId)}`,
      );
      socket.addEventListener("open", () => {
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
        const message = serverMessageSchema.safeParse(input);
        if (
          message.success &&
          (message.data.type === "snapshot" || message.data.type === "state_committed")
        ) {
          callbacks.onState(message.data.state);
        }
      });
      socket.addEventListener("close", () => {
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
    try {
      const parsed = apiErrorSchema.parse(await response.clone().json());
      code = parsed.error.code;
      message = parsed.error.message;
      currentRevision = parsed.error.currentRevision;
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
    throw new AdminApiError(response.status, code, message, currentRevision);
  }
}
