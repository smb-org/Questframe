import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BootstrapResponse, SaveResponse } from "../../../src/shared/contracts/api";
import {
  createDefaultState,
  getReleaseCapabilities,
  twitchUserIdSchema,
} from "../../../src/shared/contracts/state";
import { AdminWorkspace, type AdminApi } from "../../../src/admin/AdminWorkspace";

const actor = { twitchUserId: twitchUserIdSchema.parse("123"), displayName: "Moderator" };

const bootstrap = (): BootstrapResponse => ({
  capsule: {
    id: "irl-stream-hud",
    name: "IRL Stream HUD",
    timezone: "Europe/Berlin",
    limits: {
      maxGuests: 5,
      maxActiveEffects: 8,
      maxEditorSockets: 10,
      maxOverlaySockets: 2,
      maxMediaBytes: 8_388_608,
    },
    overlayToken: {
      exists: false,
      generation: 0,
      createdAt: null,
      lastUsedAt: null,
      connectedSockets: 0,
    },
  },
  capabilities: getReleaseCapabilities("v1b"),
  editor: { ...actor, role: "editor" },
  state: createDefaultState(actor, "2026-08-29T12:00:00.000Z"),
  recentAudit: [],
  undoTargets: [],
  csrfToken: "csrf-token-with-enough-entropy",
  serverTime: "2026-08-29T12:00:00.000Z",
});

afterEach(cleanup);

describe("Admin workspace publication boundary", () => {
  it("keeps all edits local until Save but toggles overlay visibility immediately", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    const save = vi.fn<AdminApi["save"]>((request) => {
      const response: SaveResponse = {
        state: {
          ...initial.state,
          ...request.state,
          revision: initial.state.revision + 1,
          overlayEnabled: initial.state.overlayEnabled,
          updatedAt: "2026-08-29T12:01:00.000Z",
          updatedBy: actor,
        },
        auditEntry: {
          id: "audit-1",
          revision: 2,
          action: "save",
          actor,
          summary: "HP: 42%",
          createdAt: "2026-08-29T12:01:00.000Z",
        },
        undoTargets: [],
        serverTime: "2026-08-29T12:01:00.000Z",
      };
      return Promise.resolve(response);
    });
    const setVisibility = vi.fn<AdminApi["setVisibility"]>((enabled) => Promise.resolve({
      state: { ...initial.state, revision: 2, overlayEnabled: enabled },
      auditEntry: null,
      undoTargets: [],
      serverTime: "2026-08-29T12:00:30.000Z",
    }));
    const api = { save, setVisibility } as AdminApi;
    render(<AdminWorkspace initialBootstrap={initial} api={api} />);

    expect(screen.getByText("IRL Stream HUD")).toBeInTheDocument();

    const hp = screen.getByRole("slider", { name: "Gesundheit" });
    fireEvent.change(hp, { target: { value: "42" } });

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText("Noch nicht an OBS gesendet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Änderungen speichern" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Änderungen speichern" }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].state.player.hpPercent).toBe(42);
    expect(save.mock.calls[0]?.[0].state).not.toHaveProperty("overlayEnabled");

    await user.click(screen.getByRole("switch", { name: "Overlay aktiv" }));
    expect(setVisibility).toHaveBeenCalledWith(false);
  });

  it("does not feature an effect merely because it has a description", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    initial.state.effects = [{
      id: "effect-1",
      catalogId: "buff-gestaerkt",
      kind: "buff",
      name: "Gestärkt",
      description: "Bereit für das nächste Abenteuer.",
      iconId: "buff-gestaerkt",
      stacks: null,
      expiresAt: null,
      order: 0,
    }];
    const save = vi.fn<AdminApi["save"]>((request) => Promise.resolve({
      state: {
        ...initial.state,
        ...request.state,
        revision: 2,
        updatedAt: "2026-08-29T12:01:00.000Z",
      },
      auditEntry: {
        id: "audit-2",
        revision: 2,
        action: "save",
        actor,
        summary: "Effekt bearbeitet",
        createdAt: "2026-08-29T12:01:00.000Z",
      },
      undoTargets: [],
      serverTime: "2026-08-29T12:01:00.000Z",
    }));
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save,
      setVisibility: () => Promise.resolve({ state: initial.state, auditEntry: null, undoTargets: [], serverTime: initial.serverTime }),
    }} />);

    await user.click(screen.getByRole("button", { name: "GestärktOhne Ablauf" }));
    expect(screen.getByRole("checkbox", { name: "Beschreibung im Overlay anzeigen" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Übernehmen" }));

    expect(screen.queryByText("Noch nicht an OBS gesendet")).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a nonexistent absolute channel time instead of silently shifting it", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save: vi.fn(),
      setVisibility: () => Promise.resolve({ state: initial.state, auditEntry: null, undoTargets: [], serverTime: initial.serverTime }),
    }} />);

    await user.click(screen.getByRole("button", { name: /Effekt hinzufügen/ }));
    await user.click(screen.getByRole("button", { name: "Gestärkt" }));
    fireEvent.change(screen.getByLabelText("Endet am · Europe/Berlin"), {
      target: { value: "2026-03-29T02:30" },
    });
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("existiert in Europe/Berlin nicht");
  });

  it("requires an explicit guarded replace when a remote edit arrives", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    let onState: ((state: BootstrapResponse["state"]) => void) | undefined;
    const save = vi.fn<AdminApi["save"]>((request) => Promise.resolve({
      state: {
        ...initial.state,
        ...request.state,
        revision: 3,
        updatedAt: "2026-08-29T12:02:00.000Z",
      },
      auditEntry: {
        id: "audit-3",
        revision: 3,
        action: "force_replace",
        actor,
        summary: "Entwurf ersetzt",
        createdAt: "2026-08-29T12:02:00.000Z",
      },
      undoTargets: [],
      serverTime: "2026-08-29T12:02:00.000Z",
    }));
    const api: AdminApi = {
      save,
      setVisibility: () => Promise.resolve({ state: initial.state, auditEntry: null, undoTargets: [], serverTime: initial.serverTime }),
      subscribe: (callbacks) => {
        onState = callbacks.onState;
        return () => undefined;
      },
    };
    render(<AdminWorkspace initialBootstrap={initial} api={api} />);
    fireEvent.change(screen.getByRole("slider", { name: "Gesundheit" }), { target: { value: "42" } });

    act(() => {
      onState?.({
        ...initial.state,
        revision: 2,
        player: { ...initial.state.player, hpPercent: 90 },
        updatedAt: "2026-08-29T12:01:00.000Z",
      });
    });
    await user.click(screen.getByRole("button", { name: "Änderungen speichern" }));

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("inzwischen geändert");

    await user.click(screen.getByRole("button", { name: "Meinen Entwurf veröffentlichen" }));
    const request = save.mock.calls[0]?.[0];
    expect(request?.baseRevision).toBe(1);
    expect(request?.replaceRevision).toBe(2);
    expect(request?.state.player.hpPercent).toBe(42);
  });

  it("edits the complete desktop V1b surface while preserving the explicit Save boundary", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    initial.capsule.overlayToken = {
      exists: false,
      generation: 0,
      createdAt: null,
      lastUsedAt: null,
      connectedSockets: 0,
    };
    initial.recentAudit = [{
      id: "audit-existing",
      revision: 1,
      action: "save",
      actor,
      summary: "Startzustand",
      createdAt: "2026-08-29T12:00:00.000Z",
    }];
    initial.undoTargets = [{
      revision: 1,
      createdAt: "2026-08-29T12:00:00.000Z",
      summary: "Startzustand",
    }];
    const save = vi.fn<AdminApi["save"]>((request) => Promise.resolve({
      state: {
        ...initial.state,
        ...request.state,
        revision: 2,
        updatedAt: "2026-08-29T12:01:00.000Z",
      },
      auditEntry: {
        id: "audit-save",
        revision: 2,
        action: "save",
        actor,
        summary: "Komplett geändert",
        createdAt: "2026-08-29T12:01:00.000Z",
      },
      undoTargets: initial.undoTargets,
      serverTime: "2026-08-29T12:01:00.000Z",
    }));
    const undo = vi.fn<NonNullable<AdminApi["undo"]>>(() => Promise.resolve({
      state: { ...initial.state, revision: 3 },
      auditEntry: {
        id: "audit-undo",
        revision: 3,
        action: "undo",
        actor,
        summary: "Revision wiederhergestellt",
        createdAt: "2026-08-29T12:02:00.000Z",
      },
      undoTargets: [],
      serverTime: "2026-08-29T12:02:00.000Z",
    }));
    const mutateOverlayToken = vi.fn<NonNullable<AdminApi["mutateOverlayToken"]>>((rotate, request) => Promise.resolve({
      requestId: request.requestId,
      generation: rotate ? 2 : 1,
      fingerprint: "ABCDEF12",
      createdAt: "2026-08-29T12:00:00.000Z",
    }));
    const lookupTwitchUser = vi.fn<NonNullable<AdminApi["lookupTwitchUser"]>>(() => Promise.resolve({
      id: "99999999999999999999",
      login: "gast_tv",
      displayName: "GastTV",
      profileImageUrl: "https://example.test/gast.png",
    }));
    const logout = vi.fn(() => Promise.resolve());
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<AdminWorkspace initialBootstrap={initial} api={{
      save,
      setVisibility: () => Promise.resolve({ state: initial.state, auditEntry: null, undoTargets: [], serverTime: initial.serverTime }),
      undo,
      mutateOverlayToken,
      lookupTwitchUser,
      logout,
    }} />);

    expect(screen.getAllByText("Startzustand")).toHaveLength(2);
    await user.click(screen.getByText("Einrichten").closest("summary") as HTMLElement);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Live-Charakter" } });
    fireEvent.change(screen.getByLabelText("Titel"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "31" } });
    fireEvent.change(screen.getByLabelText("Ressource"), { target: { value: "Fokus" } });
    fireEvent.change(screen.getByLabelText("Ressourcenfarbe"), { target: { value: "#123456" } });
    await user.click(screen.getByRole("button", { name: "Modern Compact" }));
    fireEvent.change(screen.getByLabelText("X"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Y"), { target: { value: "30" } });
    await user.selectOptions(screen.getByLabelText("Skalierung"), "1.1");

    await user.click(screen.getByRole("button", { name: "Pet einrichten" }));
    const companionHealth = screen.getByRole("slider", { name: "Begleiter Gesundheit" });
    fireEvent.change(companionHealth, { target: { value: "80" } });
    const companionName = companionHealth.closest(".editor-section")?.querySelector('input[maxlength="32"]');
    expect(companionName).toBeDefined();
    fireEvent.change(companionName as HTMLElement, { target: { value: "Wegbegleiter" } });
    fireEvent.change(screen.getByLabelText("Unterzeile"), { target: { value: "Spürhund" } });

    await user.type(screen.getByLabelText("Name des manuellen Gasts"), "Normalo");
    await user.click(screen.getByRole("button", { name: "Manuell" }));
    await user.type(screen.getByLabelText("Twitch-Login des Gasts"), "gast_tv");
    await user.click(screen.getByRole("button", { name: "Twitch" }));
    expect(await screen.findAllByText("GastTV")).toHaveLength(2);
    expect(lookupTwitchUser).toHaveBeenCalledWith("gast_tv");
    fireEvent.change(screen.getByRole("slider", { name: "Normalo Gesundheit" }), { target: { value: "70" } });
    await user.click(screen.getByRole("button", { name: "Normalo entfernen" }));

    await user.click(screen.getByRole("button", { name: /Effekt hinzufügen/ }));
    await user.click(screen.getByRole("button", { name: "Gestärkt" }));
    await user.click(screen.getByRole("checkbox", { name: "Endet zu einer festen Uhrzeit" }));
    await user.click(screen.getByRole("checkbox", { name: "Beschreibung im Overlay anzeigen" }));
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    expect(screen.getByText("Bereit für das nächste Abenteuer.")).toBeInTheDocument();

    await user.click(screen.getByText("OBS-Link").closest("summary") as HTMLElement);
    await user.click(screen.getByRole("button", { name: "OBS-Link erzeugen" }));
    expect(mutateOverlayToken).toHaveBeenCalledWith(false, expect.objectContaining({ expectedGeneration: 0 }));
    await user.click(screen.getByRole("button", { name: /Neuen Token erzeugen/ }));
    expect(mutateOverlayToken).toHaveBeenLastCalledWith(true, expect.objectContaining({ expectedGeneration: 1 }));

    await user.click(screen.getByRole("button", { name: "Änderungen speichern" }));
    expect(save.mock.calls[0]?.[0].state).toMatchObject({
      themeId: "modern-compact",
      placement: { x: 20, y: 30, scale: 1.1 },
      player: { name: "Live-Charakter", title: null, level: 31, resource: { name: "Fokus", color: "#123456" } },
      pet: { name: "Wegbegleiter", subtitle: "Spürhund", hpPercent: 80 },
    });

    await user.click(screen.getByText("Rückgängig").closest("summary") as HTMLElement);
    await user.click(screen.getByRole("button", { name: /Rev. 1/ }));
    expect(undo).toHaveBeenCalledWith(2, 1);
    expect(screen.getByRole("button", { name: "Abmelden" })).toBeEnabled();
    expect(logout).not.toHaveBeenCalled();
  });

  it("validates effect selection, names, descriptions and ambiguous absolute times", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save: vi.fn(),
      setVisibility: () => Promise.resolve({ state: initial.state, auditEntry: null, undoTargets: [], serverTime: initial.serverTime }),
    }} />);

    await user.click(screen.getByRole("button", { name: /Effekt hinzufügen/ }));
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    expect(screen.getByRole("alert")).toHaveTextContent("zuerst einen Effekt");

    await user.click(screen.getByRole("tab", { name: "Buffs" }));
    await user.type(screen.getByPlaceholderText("Effekt suchen …"), "Gestärkt");
    await user.click(screen.getByRole("button", { name: "Gestärkt" }));
    fireEvent.change(screen.getAllByLabelText("Name").at(-1) as HTMLElement, { target: { value: " " } });
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    expect(screen.getByRole("alert")).toHaveTextContent("braucht einen Namen");

    fireEvent.change(screen.getAllByLabelText("Name").at(-1) as HTMLElement, { target: { value: "Gestärkt" } });
    await user.click(screen.getByRole("checkbox", { name: "Beschreibung im Overlay anzeigen" }));
    fireEvent.change(screen.getByLabelText("Beschreibung (optional)"), { target: { value: " " } });
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    expect(screen.getByRole("alert")).toHaveTextContent("fehlt Text");

    fireEvent.change(screen.getByLabelText("Beschreibung (optional)"), { target: { value: "Doppelte Stunde" } });
    fireEvent.change(screen.getByLabelText("Endet am · Europe/Berlin"), { target: { value: "2026-10-25T02:30" } });
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    expect(await screen.findByText("Zeitumstellung wählen")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("zweimal");
    const choices = screen.getAllByRole("radio");
    await user.click(choices[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Doppelte Stunde")).toBeInTheDocument();
  });

  it("keeps controls honest when realtime or mutations fail", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    let onOnlineChange: ((online: boolean) => void) | undefined;
    const setVisibility = vi.fn<AdminApi["setVisibility"]>(() => Promise.reject(new Error("Sichtbarkeit fehlgeschlagen")));
    const save = vi.fn<AdminApi["save"]>(() => Promise.reject(new Error("Save fehlgeschlagen")));
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save,
      setVisibility,
      subscribe: (callbacks) => {
        onOnlineChange = callbacks.onOnlineChange;
        return () => undefined;
      },
    }} />);

    act(() => onOnlineChange?.(false));
    expect(screen.getByText(/Bearbeitung pausiert/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Änderungen speichern" })).toBeDisabled();
    act(() => onOnlineChange?.(true));
    fireEvent.change(screen.getByRole("slider", { name: "Gesundheit" }), { target: { value: "40" } });
    await user.click(screen.getByRole("button", { name: "Änderungen speichern" }));
    expect(await screen.findByText("Save fehlgeschlagen")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Overlay aktiv" }));
    expect(await screen.findByText("Sichtbarkeit fehlgeschlagen")).toBeInTheDocument();
  });
});
