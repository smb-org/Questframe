import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BootstrapResponse } from "../../../src/shared/contracts/api";
import type { ChallengeBoardSnapshot } from "../../../src/modules/win-challenges/contracts/schemas";
import { createDefaultState, getReleaseCapabilities, twitchUserIdSchema } from "../../../src/shared/contracts/state";
import { AdminWorkspace, type AdminApi } from "../../../src/admin/AdminWorkspace";

const actor = { twitchUserId: twitchUserIdSchema.parse("123"), displayName: "Moderator" };

const bootstrap = (): BootstrapResponse => ({
  capsule: {
    id: "irl-stream-hud",
    name: "IRL Stream HUD",
    timezone: "Europe/Berlin",
    limits: { maxGuests: 5, maxActiveEffects: 8, maxEditorSockets: 10, maxOverlaySockets: 10, maxMediaBytes: 8_388_608 },
    overlayToken: { exists: false, generation: 0, createdAt: null, lastUsedAt: null, connectedSockets: 0, token: null },
  },
  capabilities: getReleaseCapabilities("v1b"),
  editor: { ...actor, role: "editor" },
  state: createDefaultState(actor, "2026-08-29T12:00:00.000Z"),
  recentAudit: [],
  undoTargets: [],
  csrfToken: "csrf-token-with-enough-entropy",
  serverTime: "2026-08-29T12:00:00.000Z",
});

const challengeSnapshot = (): ChallengeBoardSnapshot => ({
  eventSeq: 0,
  boardRevision: 1,
  settingsRevision: 1,
  settings: { styleId: "plain-list", themeMode: "inherit", surfaceMode: "surface", headerTitle: "CHALLENGES", effectsEnabled: true, maxVisible: 5, globalTimer: null, placement: { x: 300, y: 8, scale: 1 } },
  challenges: [{ id: "challenge-1", title: "Wasser trinken", description: null, targetCount: null, timerTotalMs: null, sortOrder: 0, hidden: false, currentCount: 0, state: "pending", timerEndsAt: null, completedAt: null, createdAt: "2026-08-29T12:00:00.000Z", updatedAt: "2026-08-29T12:00:00.000Z" }],
});

const createCompositionApi = (snapshot: ChallengeBoardSnapshot): AdminApi => ({
  save: vi.fn(),
  setVisibility: vi.fn(),
  getChallengeBoard: vi.fn(() => Promise.resolve(snapshot)),
  saveChallengeBoard: vi.fn(),
  saveChallengeSettings: vi.fn(() => Promise.resolve({ snapshot })),
  subscribe: () => () => undefined,
});

const mockCanvasRect = (canvas: Element, width: number, height: number): void => {
  if (!(canvas instanceof HTMLElement)) throw new Error("Preview-Bühne fehlt.");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) });
};

afterEach(() => cleanup());

// Beide Tabpanels bleiben dauerhaft gemountet; HUD- und Challenge-Rail haben eigene
// gleichnamige Placement-Felder (X/Y/Skalierung). Gezielt im sichtbaren Panel suchen.
const challengesPanel = () => within(document.querySelector("#admin-composition-panel-challenges") as HTMLElement);
const hudPanel = () => within(document.querySelector("#admin-composition-panel-hud") as HTMLElement);

describe("Kompositions-Workspace", () => {
  it("schaltet nur die rechte Rail per Tabs und lässt die Bühne stehen", async () => {
    const user = userEvent.setup();
    const { container } = render(<AdminWorkspace api={createCompositionApi(challengeSnapshot())} initialBootstrap={bootstrap()} />);
    const stage = container.querySelector(".preview-canvas");
    expect(stage).toBeInTheDocument();
    const hudTab = screen.getByRole("tab", { name: "HUD" });
    const challengesTab = screen.getByRole("tab", { name: "Challenges" });
    expect(hudTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("slider", { name: "Gesundheit" })).toBeInTheDocument();

    await user.click(challengesTab);
    expect(hudTab).toHaveAttribute("aria-selected", "false");
    expect(challengesTab).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { name: "Board" })).toBeInTheDocument();
    expect(stage).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Gesundheit" })).not.toBeInTheDocument();

    challengesTab.focus();
    await user.keyboard("{ArrowLeft}");
    expect(hudTab).toHaveAttribute("aria-selected", "true");
    expect(challengesTab).toHaveAttribute("aria-selected", "false");
  });

  it("bietet die Modul-Schalter in der Vorschau-Kopfzeile an, blendet HUD und Challenges aus und macht den Save aktiv", async () => {
    const user = userEvent.setup();
    const { container } = render(<AdminWorkspace api={createCompositionApi(challengeSnapshot())} initialBootstrap={bootstrap()} />);
    await screen.findByRole("region", { name: "Challenge-Log verschieben, Pfeiltasten" });
    // Bug 5: die Schalter sitzen in der Vorschau-Kopfzeile, links vom Zoom-Regler.
    const heading = container.querySelector(".preview-panel .panel-heading");
    if (heading === null) throw new Error("Vorschau-Kopfzeile fehlt.");
    const hudToggle = within(heading as HTMLElement).getByRole("switch", { name: "HUD im Sammel-Overlay anzeigen" });
    const challengesToggle = within(heading as HTMLElement).getByRole("switch", { name: "Challenges im Sammel-Overlay anzeigen" });
    expect(within(heading as HTMLElement).getByRole("group", { name: "Im Sammel-Overlay zeigen" })).toBeInTheDocument();

    await user.click(hudToggle);
    expect(hudToggle).toHaveAttribute("aria-checked", "false");
    expect(container.querySelector(".preview-canvas .hud-root")).not.toBeInTheDocument();

    await user.click(challengesToggle);
    expect(challengesToggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("region", { name: "Challenge-Log verschieben, Pfeiltasten" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Änderungen speichern" })).toBeEnabled();
  });

  it("speichert die Modul-Mitgliedschaft, zeigt sie im Audit und stellt sie mit Undo wieder her", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    const snapshot = challengeSnapshot();
    const save = vi.fn<AdminApi["save"]>((request) => Promise.resolve({
      state: {
        ...initial.state,
        ...request.state,
        revision: 2,
        updatedAt: "2026-08-29T12:01:00.000Z",
      },
      auditEntry: {
        id: "audit-composite",
        revision: 2,
        action: "save",
        actor,
        summary: "HUD im Sammel-Overlay: Aus · Challenges im Sammel-Overlay: Aus",
        createdAt: "2026-08-29T12:01:00.000Z",
      },
      undoTargets: [{ revision: 2, createdAt: "2026-08-29T12:01:00.000Z", summary: "Sammel-Overlay geändert" }],
      serverTime: "2026-08-29T12:01:00.000Z",
    }));
    const undo = vi.fn<NonNullable<AdminApi["undo"]>>(() => Promise.resolve({
      state: { ...initial.state, revision: 3 },
      auditEntry: {
        id: "audit-composite-undo",
        revision: 3,
        action: "undo",
        actor,
        summary: "Revision 2 wiederhergestellt",
        createdAt: "2026-08-29T12:02:00.000Z",
      },
      undoTargets: [],
      serverTime: "2026-08-29T12:02:00.000Z",
    }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AdminWorkspace api={{
      save,
      setVisibility: vi.fn(),
      undo,
      getChallengeBoard: vi.fn(() => Promise.resolve(snapshot)),
      saveChallengeBoard: vi.fn(),
      saveChallengeSettings: vi.fn(() => Promise.resolve({ snapshot })),
    }} initialBootstrap={initial} />);

    await screen.findByRole("region", { name: "Challenge-Log verschieben, Pfeiltasten" });
    await user.click(screen.getByRole("switch", { name: "HUD im Sammel-Overlay anzeigen" }));
    await user.click(screen.getByRole("switch", { name: "Challenges im Sammel-Overlay anzeigen" }));
    await user.click(screen.getByRole("button", { name: "Änderungen speichern" }));

    expect(save.mock.calls[0]?.[0].baseRevision).toBe(1);
    expect(save.mock.calls[0]?.[0].state).toMatchObject({
      compositeHudVisible: false,
      compositeChallengesVisible: false,
    });
    await user.click(document.querySelector(".audit-rail .rail-heading") as HTMLElement);
    expect(screen.getByText("HUD im Sammel-Overlay: Aus · Challenges im Sammel-Overlay: Aus")).toBeInTheDocument();

    await user.click(screen.getByText("Rückgängig").closest("summary") as HTMLElement);
    await user.click(screen.getByRole("button", { name: /Rev\. 2/ }));
    expect(undo).toHaveBeenCalledWith(2, 2);
    expect(screen.getByRole("switch", { name: "HUD im Sammel-Overlay anzeigen" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Challenges im Sammel-Overlay anzeigen" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("region", { name: "Challenge-Log verschieben, Pfeiltasten" })).toBeInTheDocument();
    expect(screen.getByText("HUD im Sammel-Overlay: Aus · Challenges im Sammel-Overlay: Aus")).toBeInTheDocument();
  });

  it("zeigt Bühne und beide angedockten Rails und rechnet Drag unabhängig vom Zoom", async () => {
    const snapshot = challengeSnapshot();
    const drag = async (width: number, height: number, start: { x: number; y: number }, move: { x: number; y: number }) => {
      const { container } = render(<AdminWorkspace api={createCompositionApi(snapshot)} initialBootstrap={bootstrap()} />);

      expect(screen.getByRole("tab", { name: "HUD" })).toHaveAttribute("aria-selected", "true");
      await userEvent.setup().click(screen.getByRole("tab", { name: "Challenges" }));
      const log = await screen.findByRole("region", { name: "Challenge-Log verschieben, Pfeiltasten" });
      const canvas = container.querySelector(".preview-canvas");
      if (canvas === null) throw new Error("Preview-Bühne fehlt.");
      mockCanvasRect(canvas, width, height);
      fireEvent.pointerDown(log, { button: 0, clientX: start.x, clientY: start.y, pointerId: 1 });
      fireEvent.pointerMove(log, { clientX: move.x, clientY: move.y, pointerId: 1 });
      fireEvent.pointerUp(log, { clientX: move.x, clientY: move.y, pointerId: 1 });
      await waitFor(() => expect(challengesPanel().getByLabelText("X")).toHaveValue(320));
      const xField = challengesPanel().getByLabelText("X");
      const yField = challengesPanel().getByLabelText("Y");
      if (!(xField instanceof HTMLInputElement) || !(yField instanceof HTMLInputElement)) throw new Error("Challenge-Placement-Feld fehlt.");
      const placement = { x: Number(xField.value), y: Number(yField.value) };
      cleanup();
      return placement;
    };

    const at100 = await drag(1920, 1080, { x: 1_600, y: 100 }, { x: 1_700, y: 200 });
    const at200 = await drag(3_840, 2_160, { x: 3_200, y: 200 }, { x: 3_400, y: 400 });
    expect(at100).toEqual({ x: 320, y: 28 });
    expect(at200).toEqual(at100);
  });

  it("ändert das Placement bei einem Klick ohne Bewegung nicht", async () => {
    const { container } = render(<AdminWorkspace api={createCompositionApi(challengeSnapshot())} initialBootstrap={bootstrap()} />);
    await userEvent.setup().click(screen.getByRole("tab", { name: "Challenges" }));
    const log = await screen.findByRole("region", { name: "Challenge-Log verschieben, Pfeiltasten" });
    const canvas = container.querySelector(".preview-canvas");
    if (canvas === null) throw new Error("Preview-Bühne fehlt.");
    mockCanvasRect(canvas, 1_920, 1_080);
    fireEvent.pointerDown(log, { button: 0, clientX: 1_600, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(log, { clientX: 1_600, clientY: 100, pointerId: 1 });
    expect(challengesPanel().getByLabelText("X")).toHaveValue(300);
    expect(challengesPanel().getByLabelText("Y")).toHaveValue(8);
  });

  it("verschiebt beim Drag aus der Modulmitte um das Cursor-Delta", async () => {
    const { container } = render(<AdminWorkspace api={createCompositionApi(challengeSnapshot())} initialBootstrap={bootstrap()} />);
    await userEvent.setup().click(screen.getByRole("tab", { name: "Challenges" }));
    const log = await screen.findByRole("region", { name: "Challenge-Log verschieben, Pfeiltasten" });
    const canvas = container.querySelector(".preview-canvas");
    if (canvas === null) throw new Error("Preview-Bühne fehlt.");
    mockCanvasRect(canvas, 1_920, 1_080);
    fireEvent.pointerDown(log, { button: 0, clientX: 1_670, clientY: 190, pointerId: 1 });
    fireEvent.pointerMove(log, { clientX: 1_770, clientY: 240, pointerId: 1 });
    fireEvent.pointerUp(log, { clientX: 1_770, clientY: 240, pointerId: 1 });
    await waitFor(() => expect(challengesPanel().getByLabelText("X")).toHaveValue(320));
    expect(challengesPanel().getByLabelText("Y")).toHaveValue(18);
  });

  it("draggt das HUD in 1:1-Einheiten statt im Challenge-Raster", async () => {
    const { container } = render(<AdminWorkspace api={createCompositionApi(challengeSnapshot())} initialBootstrap={bootstrap()} />);
    const hud = await screen.findByLabelText("HUD-Modul verschieben, Pfeiltasten");
    const canvas = container.querySelector(".preview-canvas");
    if (canvas === null) throw new Error("Preview-Bühne fehlt.");
    mockCanvasRect(canvas, 1_920, 1_080);
    fireEvent.pointerDown(hud, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(hud, { clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(hud, { clientX: 200, clientY: 200, pointerId: 1 });
    await waitFor(() => expect(hudPanel().getByLabelText("X")).toHaveValue(112));
    expect(hudPanel().getByLabelText("Y")).toHaveValue(112);
  });

  it("zeigt im Kompositions-Preview den ungespeicherten HUD-Entwurf", async () => {
    const user = userEvent.setup();
    const { container } = render(<AdminWorkspace api={createCompositionApi(challengeSnapshot())} initialBootstrap={bootstrap()} />);
    const name = screen.getByDisplayValue("Streamer");
    await user.clear(name);
    await user.type(name, "Draft Streamer");
    expect(container.querySelector(".preview-canvas .hud-player-name")).toHaveTextContent("Draft Streamer");
  });

  it("ignoriert fremde Pointer und beendet Drag bei pointercancel", async () => {
    const { container } = render(<AdminWorkspace api={createCompositionApi(challengeSnapshot())} initialBootstrap={bootstrap()} />);
    await userEvent.setup().click(screen.getByRole("tab", { name: "Challenges" }));
    const log = await screen.findByRole("region", { name: "Challenge-Log verschieben, Pfeiltasten" });
    const canvas = container.querySelector(".preview-canvas");
    if (canvas === null) throw new Error("Preview-Bühne fehlt.");
    mockCanvasRect(canvas, 1_920, 1_080);
    fireEvent.pointerDown(log, { button: 0, clientX: 1_600, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(log, { clientX: 1_700, clientY: 200, pointerId: 2 });
    expect(challengesPanel().getByLabelText("X")).toHaveValue(300);
    fireEvent.pointerMove(log, { clientX: 1_700, clientY: 200, pointerId: 1 });
    await waitFor(() => expect(challengesPanel().getByLabelText("X")).toHaveValue(320));
    fireEvent.pointerCancel(log, { clientX: 1_700, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(log, { clientX: 1_800, clientY: 300, pointerId: 1 });
    expect(challengesPanel().getByLabelText("X")).toHaveValue(320);
    expect(challengesPanel().getByLabelText("Y")).toHaveValue(28);
  });

  it("verschiebt das fokussierte Challenge-Log per Pfeiltasten in Einheiten", async () => {
    const log = await (async () => {
      render(<AdminWorkspace api={createCompositionApi(challengeSnapshot())} initialBootstrap={bootstrap()} />);
      await userEvent.setup().click(screen.getByRole("tab", { name: "Challenges" }));
      return screen.findByRole("region", { name: "Challenge-Log verschieben, Pfeiltasten" });
    })();
    fireEvent.keyDown(log, { key: "ArrowRight" });
    fireEvent.keyDown(log, { key: "ArrowDown", shiftKey: true });
    await waitFor(() => expect(challengesPanel().getByLabelText("X")).toHaveValue(301));
    expect(challengesPanel().getByLabelText("Y")).toHaveValue(18);
  });

  it("hält HUD- und Challenge-Save getrennt", async () => {
    const user = userEvent.setup();
    const snapshot = challengeSnapshot();
    const save = vi.fn(() => Promise.resolve({ state: bootstrap().state, auditEntry: { id: "audit-1", revision: 2, action: "save" as const, actor, summary: "HUD gespeichert", createdAt: "2026-08-29T12:00:00.000Z" }, undoTargets: [], serverTime: "2026-08-29T12:00:00.000Z" }));
    const saveChallengeSettings = vi.fn(() => Promise.resolve({ snapshot: { ...snapshot, settingsRevision: 2, settings: { ...snapshot.settings, placement: { x: 200, y: 8, scale: 1 } } } }));
    const api: AdminApi = { save, setVisibility: vi.fn(), getChallengeBoard: vi.fn(() => Promise.resolve(snapshot)), saveChallengeBoard: vi.fn(), saveChallengeSettings, subscribe: () => () => undefined };
    render(<AdminWorkspace api={api} initialBootstrap={bootstrap()} />);
    await userEvent.setup().click(screen.getByRole("tab", { name: "Challenges" }));
    await screen.findByRole("region", { name: "Challenge-Log verschieben, Pfeiltasten" });
    fireEvent.change(challengesPanel().getByLabelText("X"), { target: { value: "200" } });
    await user.click(screen.getByRole("button", { name: "Challenge-Einstellungen speichern" }));
    expect(saveChallengeSettings).toHaveBeenCalledWith(expect.objectContaining({ placement: { x: 200, y: 8, scale: 1 } }));
    expect(save).not.toHaveBeenCalled();
  });

  // Bug 1: OBS-Einrichtung ist ein natives <dialog> (Popover), das die Buehne nie
  // verschiebt und per Escape schließt, mit Fokus-Rückgabe an den auslösenden Chip.
  it("zeigt die OBS-Einrichtung als Dialog, ohne die Vorschau zu verschieben, und schließt per Escape mit Fokus-Rückgabe", async () => {
    const user = userEvent.setup();
    const { container } = render(<AdminWorkspace api={createCompositionApi(challengeSnapshot())} initialBootstrap={bootstrap()} />);
    const main = container.querySelector(".composition-main");
    if (main === null) throw new Error("composition-main fehlt.");
    expect(main.firstElementChild).toHaveClass("preview-panel");
    const dialog = document.querySelector("dialog#admin-obs-setup");
    if (dialog === null) throw new Error("OBS-Setup-Dialog fehlt.");
    expect(dialog).not.toHaveAttribute("open");

    const trigger = screen.getByRole("button", { name: "OBS-Einrichtung öffnen" });
    await user.click(trigger);
    expect(screen.getByRole("button", { name: "OBS-Einrichtung schließen" })).toHaveAttribute("aria-expanded", "true");
    expect(dialog).toHaveAttribute("open");
    expect(within(dialog as HTMLElement).getByRole("heading", { name: "Alle Quellen auf einen Blick" })).toBeInTheDocument();
    expect(main.firstElementChild).toHaveClass("preview-panel");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(screen.getByRole("button", { name: "OBS-Einrichtung öffnen" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "OBS-Einrichtung öffnen" })).toHaveFocus();

    // Klick auf die Dialogflaeche selbst (statt auf ein Kind) simuliert den nativen
    // Backdrop-Klick von showModal(): das Ziel ist dann der Dialog selbst.
    await user.click(trigger);
    expect(dialog).toHaveAttribute("open");
    fireEvent.click(dialog);
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
  });

  // Bug 7: ein Button an der Buehne fuer beide Placements, nur aktiv bei Abweichung
  // vom committeten Stand, offline gesperrt.
  it("aktiviert Positionen übernehmen erst bei Verschiebung und sperrt es offline", async () => {
    let onOnlineChange: ((online: boolean) => void) | undefined;
    const { container } = render(<AdminWorkspace api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
      getChallengeBoard: vi.fn(() => Promise.resolve(challengeSnapshot())),
      saveChallengeBoard: vi.fn(),
      saveChallengeSettings: vi.fn(),
      subscribe: (callbacks) => { onOnlineChange = callbacks.onOnlineChange; return () => undefined; },
    }} initialBootstrap={bootstrap()} />);
    await screen.findByRole("region", { name: "Challenge-Log verschieben, Pfeiltasten" });
    const commitButton = screen.getByRole("button", { name: "Positionen übernehmen" });
    expect(commitButton).toBeDisabled();

    const hud = screen.getByLabelText("HUD-Modul verschieben, Pfeiltasten");
    const canvas = container.querySelector(".preview-canvas");
    if (canvas === null) throw new Error("Preview-Bühne fehlt.");
    mockCanvasRect(canvas, 1_920, 1_080);
    fireEvent.pointerDown(hud, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(hud, { clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(hud, { clientX: 200, clientY: 200, pointerId: 1 });
    await waitFor(() => expect(commitButton).toBeEnabled());

    act(() => onOnlineChange?.(false));
    expect(commitButton).toBeDisabled();
  });

  // Bug 7 – wichtigster Test: der Positions-Button darf nur das Placement committen,
  // keine anderen offenen Draft-Änderungen (hier: der geänderte Spielername).
  it("übernimmt per Positions-Button nur die HUD-Position, ohne andere Draft-Änderungen zu veröffentlichen", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    const save = vi.fn<AdminApi["save"]>((request) => Promise.resolve({
      state: { ...initial.state, ...request.state, revision: 2, updatedAt: "2026-08-29T12:01:00.000Z", updatedBy: actor },
      auditEntry: { id: "audit-placement", revision: 2, action: "save", actor, summary: "Position übernommen", createdAt: "2026-08-29T12:01:00.000Z" },
      undoTargets: [],
      serverTime: "2026-08-29T12:01:00.000Z",
    }));
    const { container } = render(<AdminWorkspace api={{
      save,
      setVisibility: vi.fn(),
      getChallengeBoard: vi.fn(() => Promise.resolve(challengeSnapshot())),
      saveChallengeBoard: vi.fn(),
      saveChallengeSettings: vi.fn(),
      subscribe: () => () => undefined,
    }} initialBootstrap={initial} />);

    const name = screen.getByDisplayValue("Streamer");
    await user.clear(name);
    await user.type(name, "Draft Streamer");

    const hud = await screen.findByLabelText("HUD-Modul verschieben, Pfeiltasten");
    const canvas = container.querySelector(".preview-canvas");
    if (canvas === null) throw new Error("Preview-Bühne fehlt.");
    mockCanvasRect(canvas, 1_920, 1_080);
    fireEvent.pointerDown(hud, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(hud, { clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(hud, { clientX: 200, clientY: 200, pointerId: 1 });

    const commitButton = await screen.findByRole("button", { name: "Positionen übernehmen" });
    await waitFor(() => expect(commitButton).toBeEnabled());
    await user.click(commitButton);

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const request = save.mock.calls[0]?.[0];
    expect(request?.baseRevision).toBe(1);
    expect(request?.state.placement).toEqual({ x: 112, y: 112, scale: 1 });
    expect(request?.state.player.name).toBe("Streamer");
    expect(screen.getByDisplayValue("Draft Streamer")).toBeInTheDocument();
    expect(await screen.findByText("Positionen übernommen.")).toBeInTheDocument();
  });
});
