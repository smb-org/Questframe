import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayApp } from "../../../src/overlay/OverlayApp";
import {
  fingerprintOverlayToken,
  loadOverlaySnapshot,
  storeOverlaySnapshot,
} from "../../../src/overlay/cache";
import { createDefaultState, twitchUserIdSchema } from "../../../src/shared/contracts/state";

const token = "A".repeat(43);
const actor = { twitchUserId: "123", displayName: "Moderator" };
const channelState = () => createDefaultState(actor, "2026-08-29T12:00:00.000Z");

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
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
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
  localStorage.clear();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  window.history.replaceState({}, "", `/overlay?token=${token}`);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OverlayApp realtime shell", () => {
  it("stays transparent and opens no connection for missing or malformed tokens", async () => {
    window.history.replaceState({}, "", "/overlay?token=short");
    const { container } = render(<OverlayApp />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container).toBeEmptyDOMElement();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("restores a token-scoped snapshot before connecting and stores newer commits", async () => {
    const fingerprint = await fingerprintOverlayToken(token);
    const cached = channelState();
    storeOverlaySnapshot(window.location.host, fingerprint, cached);
    render(<OverlayApp />);

    expect(await screen.findByText("Streamer")).toBeInTheDocument();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toContain(`/ws/overlay?token=${token}`);

    const committed = {
      ...cached,
      revision: 2,
      player: { ...cached.player, hpPercent: 42 },
      updatedAt: "2026-08-29T12:01:00.000Z",
    };
    act(() => {
      socket?.emit("message", new Blob());
      socket?.emit("message", "not-json");
      socket?.emit("message", JSON.stringify({ type: "history_changed", undoTargets: [] }));
      socket?.emit("message", JSON.stringify({ type: "state_committed", state: committed }));
    });
    expect(screen.getByTestId("player-health")).toHaveAttribute("aria-valuenow", "42");
    expect(loadOverlaySnapshot(window.location.host, fingerprint)?.revision).toBe(2);
  });

  it("blanks and removes its cached snapshot on active token revocation", async () => {
    const fingerprint = await fingerprintOverlayToken(token);
    storeOverlaySnapshot(window.location.host, fingerprint, channelState());
    const { container } = render(<OverlayApp />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket?.emit("message", JSON.stringify({ type: "token_revoked" }));
    });
    expect(container).toBeEmptyDOMElement();
    expect(socket?.closed).toBe(true);
    expect(loadOverlaySnapshot(window.location.host, fingerprint)).toBeNull();
    act(() => {
      socket?.emit("close");
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reconnects with jittered exponential backoff and cancels pending work on unmount", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const view = render(<OverlayApp />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const first = FakeWebSocket.instances[0];
    act(() => {
      first?.emit("open");
      first?.emit("close");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(950);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    view.unmount();
    expect(FakeWebSocket.instances[1]?.closed).toBe(true);
    act(() => {
      FakeWebSocket.instances[1]?.emit("close");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("loads each distinct uploaded portrait once and revokes stale object URLs", async () => {
    const createObjectURL = vi.fn(() => "blob:portrait-1");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Blob(["portrait"], { type: "image/webp" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(<OverlayApp />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const hash = "a".repeat(64);
    const uploaded = { kind: "uploaded" as const, contentHash: hash };
    const state = channelState();
    const withUploads = {
      ...state,
      player: { ...state.player, portrait: uploaded },
      pet: { name: "Begleiter", subtitle: null, portrait: uploaded, hpPercent: 100 },
      group: [{
        id: "guest-1",
        source: "twitch" as const,
        twitchUserId: twitchUserIdSchema.parse("999"),
        name: "GastTV",
        portrait: uploaded,
        hpPercent: 100,
      }],
    };
    act(() => {
      FakeWebSocket.instances[0]?.emit("message", JSON.stringify({ type: "snapshot", state: withUploads }));
    });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(fetcher).toHaveBeenCalledWith(`/api/media/${hash}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(container.querySelectorAll("img.hud-portrait-image")).toHaveLength(3);

    act(() => {
      FakeWebSocket.instances[0]?.emit("message", JSON.stringify({ type: "snapshot", state }));
    });
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:portrait-1"));
  });

  it("revokes a portrait blob that finishes loading after disposal", async () => {
    const revokeObjectURL = vi.fn();
    const createObjectURL = vi.fn(() => "blob:late");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<OverlayApp />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const base = channelState();
    const uploaded = { kind: "uploaded" as const, contentHash: "b".repeat(64) };
    act(() => {
      FakeWebSocket.instances[0]?.emit("message", JSON.stringify({
        type: "snapshot",
        state: { ...base, player: { ...base.player, portrait: uploaded } },
      }));
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    view.unmount();
    resolveFetch?.(new Response(new Blob(["late"]), { status: 200 }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:late");
  });
});
