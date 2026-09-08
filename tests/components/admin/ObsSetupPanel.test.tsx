import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FlushDisplaySocketsResponse } from "../../../src/shared/contracts/api";
import { ObsSetupPanel } from "../../../src/admin/ui/ObsSetupPanel";
import {
  createChallengeObsSources,
  type DockTokenStatus,
  type OverlayTokenStatus,
} from "../../../src/admin/ui/obsSetup";

const overlayToken: OverlayTokenStatus = {
  exists: true,
  generation: 1,
  createdAt: "2026-08-29T12:00:00.000Z",
  lastUsedAt: null,
  connectedSockets: 2,
  token: "O".repeat(43),
};

const dockToken: DockTokenStatus = {
  exists: true,
  generation: 1,
  fingerprint: "ABCDEF12",
  createdAt: "2026-08-29T12:00:00.000Z",
  lastUsedAt: null,
  connectedSockets: 1,
  token: "D".repeat(43),
};

const renderPanel = (online: boolean, flushDisplaySockets: () => Promise<FlushDisplaySocketsResponse>) =>
  render(
    <ObsSetupPanel
      api={{ flushDisplaySockets }}
      dockToken={dockToken}
      online={online}
      onDockToken={vi.fn()}
      onOverlayToken={vi.fn()}
      overlayToken={overlayToken}
      sources={createChallengeObsSources("http://localhost:5173", overlayToken, dockToken)}
    />,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OBS-Einrichtung", () => {
  it("trennt Verbindungen ohne Bestätigungsdialog und zeigt die Anzahl kurz an", async () => {
    const user = userEvent.setup();
    let resolveFlush: ((result: FlushDisplaySocketsResponse) => void) | undefined;
    const flushDisplaySockets = vi.fn(() => new Promise<FlushDisplaySocketsResponse>((resolve) => {
      resolveFlush = resolve;
    }));
    const confirm = vi.spyOn(window, "confirm");
    renderPanel(true, flushDisplaySockets);

    const button = screen.getByRole("button", { name: "Verbindungen trennen" });
    expect(button).toBeEnabled();
    expect(screen.getByText(/Alle Quellen verbinden sich kurz neu; die Anzeige blinkt dabei einmal/)).toBeInTheDocument();
    expect(screen.getByText(/Token bleibt gültig – anders als bei einer Token-Rotation/)).toBeInTheDocument();

    await user.click(button);
    expect(button).toBeDisabled();
    expect(flushDisplaySockets).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();

    resolveFlush?.({ closed: 3 });
    expect(await screen.findByText("3 Verbindungen getrennt.")).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it("deaktiviert den Notbremsen-Knopf offline", () => {
    const flushDisplaySockets = vi.fn<() => Promise<FlushDisplaySocketsResponse>>();
    renderPanel(false, flushDisplaySockets);

    expect(screen.getByRole("button", { name: "Verbindungen trennen" })).toBeDisabled();
    expect(flushDisplaySockets).not.toHaveBeenCalled();
  });
});
