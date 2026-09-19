import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BootstrapResponse } from "../../../src/shared/contracts/api";
import type * as AdminApiModule from "../../../src/admin/api";
import {
  createDefaultState,
  getReleaseCapabilities,
  twitchUserIdSchema,
} from "../../../src/shared/contracts/state";

const apiMocks = vi.hoisted(() => ({
  bootstrap: vi.fn<() => Promise<BootstrapResponse>>(),
  revalidate: vi.fn<() => Promise<void>>(),
}));

vi.mock("../../../src/admin/api", async (importOriginal) => {
  const actual = await importOriginal<typeof AdminApiModule>();
  return {
    ...actual,
    BrowserAdminApi: class {
      bootstrap = apiMocks.bootstrap;
      revalidate = apiMocks.revalidate;
    },
  };
});

import { AdminApp, LoginApp } from "../../../src/admin/AdminApp";
import { AdminApiError } from "../../../src/admin/api";

const actor = {
  twitchUserId: twitchUserIdSchema.parse("12345678901234567890"),
  displayName: "Moderator",
};

const bootstrap = (): BootstrapResponse => ({
  capsule: {
    id: "irl-stream-hud",
    name: "Beispielkanal",
    timezone: "Europe/Berlin",
    limits: {
      maxGuests: 5,
      maxActiveEffects: 8,
      maxEditorSockets: 10,
      maxOverlaySockets: 10,
      maxMediaBytes: 8_388_608,
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
  editor: { ...actor, role: "editor" },
  state: createDefaultState(actor, "2026-08-29T12:00:00.000Z"),
  recentAudit: [],
  undoTargets: [],
  challengeUndoTargets: [],
  csrfToken: "csrf-token-with-enough-entropy",
  serverTime: "2026-08-29T12:00:00.000Z",
});

beforeEach(() => {
  apiMocks.bootstrap.mockReset();
  apiMocks.revalidate.mockReset().mockResolvedValue();
  window.history.replaceState({}, "", "/admin");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AdminApp authentication shell", () => {
  it("copies a recoverable bootstrap token before any token generation", async () => {
    const user = userEvent.setup();
    const recoverable = bootstrap();
    recoverable.capsule.overlayToken = {
      exists: true,
      generation: 1,
      createdAt: "2026-08-29T12:00:00.000Z",
      lastUsedAt: null,
      connectedSockets: 0,
      token: "A".repeat(43),
    };
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    apiMocks.bootstrap.mockResolvedValue(recoverable);

    render(<AdminApp />);

    const copyButton = await screen.findByRole("button", { name: "OBS-Link kopieren" });
    expect(copyButton).toBeEnabled();
    await user.click(copyButton);
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/overlay/all#token=${"A".repeat(43)}`);
  });

  it("keeps the explanation for an existing legacy token without recoverable plaintext reachable", async () => {
    const legacy = bootstrap();
    legacy.capsule.overlayToken = {
      exists: true,
      generation: 1,
      createdAt: "2026-08-29T12:00:00.000Z",
      lastUsedAt: null,
      connectedSockets: 0,
      token: null,
    };
    apiMocks.bootstrap.mockResolvedValue(legacy);

    render(<AdminApp />);

    const copyButton = await screen.findByRole("button", { name: "OBS-Link kopieren" });
    expect(copyButton).toBeEnabled();
    expect(copyButton).toHaveAttribute("aria-disabled", "true");
    expect(copyButton).toHaveAccessibleDescription(
      "Dieser alte Token ist nicht wiederherstellbar. Bitte einen neuen Token erzeugen.",
    );
  });

  it("shows a loading shell and then mounts the complete workspace", async () => {
    let resolveBootstrap: ((value: BootstrapResponse) => void) | undefined;
    apiMocks.bootstrap.mockReturnValue(new Promise((resolve) => {
      resolveBootstrap = resolve;
    }));
    render(<AdminApp />);
    expect(screen.getByLabelText("Editor wird geladen")).toHaveAttribute("aria-busy", "true");

    resolveBootstrap?.(bootstrap());
    expect(await screen.findByRole("heading", { name: "Live-Vorschau" })).toBeInTheDocument();
    expect(screen.getByText("Moderator")).toBeInTheDocument();
  });

  it.each([
    [new AdminApiError(401, "unauthorized", "Anmelden"), "Live-Regie öffnen"],
    [new AdminApiError(403, "role_ineligible", "Kein Mod"), "Kein Editor-Zugriff"],
  ])("maps authentication failures to a safe login card", async (error, heading) => {
    apiMocks.bootstrap.mockRejectedValue(error);
    render(<AdminApp />);
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Mit Twitch anmelden" })).toHaveAttribute(
      "href",
      "/auth/twitch/start",
    );
  });

  it("shows a retry surface for unknown bootstrap failures", async () => {
    apiMocks.bootstrap.mockRejectedValue(new Error("private detail"));
    render(<AdminApp />);
    expect(await screen.findByRole("heading", { name: "Verbindung nicht möglich" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeEnabled();
  });

  it("revalidates a mounted editor session hourly", async () => {
    vi.useFakeTimers();
    apiMocks.bootstrap.mockResolvedValue(bootstrap());
    render(<AdminApp />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: "Live-Vorschau" })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(55 * 60 * 1_000);
    });
    expect(apiMocks.revalidate).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(apiMocks.revalidate).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(apiMocks.revalidate).toHaveBeenCalledTimes(2);
  });

  it("renders the explicit login route error without making a bootstrap request", () => {
    window.history.replaceState({}, "", "/login?error=not_editor");
    render(<LoginApp />);
    expect(screen.getByText("Questframe")).toBeInTheDocument();
    expect(screen.getByText(/Broadcaster und aktuell eingetragene Twitch-Moderator:innen/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Kein Editor-Zugriff" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Mit Twitch anmelden" })).toBeInTheDocument();
    expect(apiMocks.bootstrap).not.toHaveBeenCalled();
  });
});
