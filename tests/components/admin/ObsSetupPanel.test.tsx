import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FlushDisplaySocketsResponse } from "../../../src/shared/contracts/api";
import { ObsSetupPanel } from "../../../src/admin/ui/ObsSetupPanel";
import {
  createChallengeObsSources,
  type DockTokenStatus,
  type ObsSetupApi,
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
  it("enthüllt OBS-Token nur auf Wunsch und kopiert den echten Link samt QR-Schutzinfo", async () => {
    const user = userEvent.setup();
    const overlayTokenValue = "O".repeat(43);
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      <ObsSetupPanel
        api={{}}
        dockToken={dockToken}
        online
        onDockToken={vi.fn()}
        onOverlayToken={vi.fn()}
        overlayToken={overlayToken}
        sources={createChallengeObsSources("http://localhost:5173", overlayToken, dockToken)}
      />,
    );

    const hudUrl = screen.getByLabelText("HUD-Overlay URL");
    expect(hudUrl).toHaveTextContent("#token=••••••");
    expect(screen.getByRole("button", { name: "Verbindungen trennen" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "URLs anzeigen" }));
    expect(hudUrl).toHaveTextContent(`http://localhost:5173/overlay#token=${overlayTokenValue}`);
    expect(await screen.findByRole("img", { name: "QR-Code für die Live-Bedienseite" })).toHaveAttribute("src", expect.stringMatching(/^data:image\/png/u));
    expect(screen.getByText("QR-Code nicht im Stream zeigen – er enthält Schreibzugriff auf deine Challenges.")).toBeInTheDocument();

    const copyButton = screen.getByRole("button", { name: "HUD-Overlay-URL kopieren" });
    await user.click(copyButton);
    expect(writeText).toHaveBeenCalledWith(`http://localhost:5173/overlay#token=${overlayTokenValue}`);
    expect(copyButton).toHaveTextContent("Kopiert");
    await user.click(copyButton);
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("fordert vor Token-Rotation Zustimmung und übernimmt neue Overlay- und Dock-Credentials", async () => {
    const user = userEvent.setup();
    const createdAt = "2026-11-17T10:05:00.000Z";
    const mutateOverlayToken = vi.fn<NonNullable<ObsSetupApi["mutateOverlayToken"]>>((rotate, request) => {
      void rotate;
      void request;
      return Promise.resolve({
        requestId: "b33187e2-6262-4cd8-9c3f-37008a5ed68a",
        generation: 2,
        fingerprint: "87654321",
        createdAt,
        token: "N".repeat(43),
      });
    });
    const mutateDockToken = vi.fn<NonNullable<ObsSetupApi["mutateDockToken"]>>((rotate, request) => {
      void rotate;
      void request;
      return Promise.resolve({
        requestId: "82940bde-50e1-44a8-87a3-842c272cb09b",
        generation: 2,
        fingerprint: "1234ABCD",
        createdAt,
        token: "K".repeat(43),
      });
    });
    const onOverlayToken = vi.fn();
    const onDockToken = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    render(
      <ObsSetupPanel
        api={{ mutateOverlayToken, mutateDockToken }}
        dockToken={dockToken}
        online
        onDockToken={onDockToken}
        onOverlayToken={onOverlayToken}
        overlayToken={overlayToken}
        sources={createChallengeObsSources("http://localhost:5173", overlayToken, dockToken)}
      />,
    );

    const hudSource = document.querySelector(".challenge-setup__source--hud");
    const liveSource = document.querySelector(".challenge-setup__source--live");
    if (!(hudSource instanceof HTMLElement) || !(liveSource instanceof HTMLElement)) throw new Error("OBS-Quellen fehlen.");
    const hudButton = within(hudSource).getByRole("button", { name: "Token ersetzen" });
    await user.click(hudButton);
    expect(confirm).toHaveBeenLastCalledWith("Alte Token-URL sofort ungültig machen und neuen Token erzeugen?");
    expect(mutateOverlayToken).not.toHaveBeenCalled();

    await user.click(hudButton);
    await waitFor(() => expect(onOverlayToken).toHaveBeenCalledWith({
      ...overlayToken,
      generation: 2,
      createdAt,
      lastUsedAt: null,
      connectedSockets: 0,
      token: "N".repeat(43),
    }));
    expect(mutateOverlayToken).toHaveBeenCalledWith(true, expect.objectContaining({ expectedGeneration: 1 }));

    await user.click(within(liveSource).getByRole("button", { name: "Token ersetzen" }));
    await waitFor(() => expect(onDockToken).toHaveBeenCalledWith({
      ...dockToken,
      generation: 2,
      fingerprint: "1234ABCD",
      createdAt,
      lastUsedAt: null,
      connectedSockets: 0,
      token: "K".repeat(43),
    }));
    expect(mutateDockToken).toHaveBeenCalledWith(true, expect.objectContaining({ expectedGeneration: 1 }));
  });

  it("zeigt verständliche Fehler bei verweigerter Zwischenablage und fehlgeschlagenem Socket-Neustart", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(() => Promise.reject(new Error("clipboard denied"))) } });
    const flushDisplaySockets = vi.fn<() => Promise<FlushDisplaySocketsResponse>>()
      .mockRejectedValueOnce(new Error("Worker nicht erreichbar"))
      .mockRejectedValueOnce("private upstream response");
    renderPanel(true, flushDisplaySockets);

    await user.click(screen.getByRole("button", { name: "HUD-Overlay-URL kopieren" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Link konnte nicht kopiert werden.");
    await user.click(screen.getByRole("button", { name: "Verbindungen trennen" }));
    expect(await screen.findByText("Worker nicht erreichbar")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Verbindungen trennen" }));
    expect(await screen.findByText("Verbindungen konnten nicht getrennt werden.")).toBeInTheDocument();
    expect(flushDisplaySockets).toHaveBeenCalledTimes(2);
  });

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
