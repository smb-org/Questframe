import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuditEntry, BootstrapResponse, SaveResponse, UndoTarget } from "../../../src/shared/contracts/api";
import {
  createDefaultState,
  getReleaseCapabilities,
  twitchUserIdSchema,
} from "../../../src/shared/contracts/state";
import type { ChallengeBoardSnapshot, Command } from "../../../src/modules/win-challenges/contracts/schemas";
import type { ChallengeUpdate } from "../../../src/shared/contracts/win-challenges";
import { AdminWorkspace, type AdminApi } from "../../../src/admin/AdminWorkspace";

vi.mock("qrcode", () => ({
  toDataURL: vi.fn(() => Promise.resolve("data:image/png;base64,challenge-qr")),
}));

const actor = { twitchUserId: twitchUserIdSchema.parse("123"), displayName: "Moderator" };

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
  csrfToken: "csrf-token-with-enough-entropy",
  serverTime: "2026-08-29T12:00:00.000Z",
});

const auditToggle = (): HTMLButtonElement => {
  const button = document.querySelector(".audit-rail .rail-heading");
  if (!(button instanceof HTMLButtonElement)) throw new Error("Audit-Schalter fehlt.");
  return button;
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Admin workspace channel identity", () => {
  it("names the edited Twitch channel in the header and stays quiet without one", () => {
    const withChannel = bootstrap();
    withChannel.capsule.channel = {
      id: twitchUserIdSchema.parse("456"),
      login: "twitchbrudi",
      displayName: "TwitchBrudi",
    };
    const { unmount } = render(<AdminWorkspace initialBootstrap={withChannel} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
    }} />);

    const identity = document.querySelector(".channel-identity");
    expect(identity).toHaveTextContent("Twitch-Kanal");
    expect(identity).toHaveTextContent("TwitchBrudi");
    unmount();
    cleanup();

    render(<AdminWorkspace initialBootstrap={bootstrap()} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
    }} />);
    const placeholder = document.querySelector(".channel-identity");
    expect(placeholder).toBeInTheDocument();
    expect(placeholder).toHaveAttribute("aria-hidden", "true");
    expect(placeholder).toBeEmptyDOMElement();
  });
});

describe("Admin workspace shell", () => {
  it("stellt dynamische OBS-Einrichtungslabels und Lucide-Token-Icons wieder her", async () => {
    const initial = bootstrap();
    initial.capsule.overlayToken = {
      exists: true,
      generation: 2,
      createdAt: "2026-08-29T12:00:00.000Z",
      lastUsedAt: null,
      connectedSockets: 0,
      token: "overlay-token",
    };
    const user = userEvent.setup();
    render(<AdminWorkspace api={{ save: vi.fn(), setVisibility: vi.fn() }} initialBootstrap={initial} />);

    const setup = screen.getByRole("button", { name: "OBS-Einrichtung öffnen" });
    expect(setup).toHaveAttribute("title", "Einrichtung");
    await user.click(setup);
    expect(screen.getByRole("button", { name: "OBS-Einrichtung schließen" })).toHaveAttribute("title", "Einrichtung schließen");

    const rotate = screen.getByRole("button", { name: "Neuen Token erzeugen" });
    expect(rotate.querySelector("svg")).not.toBeNull();
    expect(rotate).not.toHaveTextContent("↻");
  });

  it("zeigt den Challenge-Tab und hält die HUD-editor-rail unsichtbar, markiert beide Bereiche", async () => {
    const challengeSnapshot: ChallengeBoardSnapshot = {
      eventSeq: 0,
      boardRevision: 1,
      settingsRevision: 1,
      settings: {
        styleId: "plain-list",
        themeMode: "inherit",
        surfaceOpacity: 100,
        headerStyle: "default",
        fontFamily: "theme",
        fontScale: 1,
        headerTitle: "CHALLENGES",
        penaltyText: "",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end", globalTimerMode: "down",
        globalTimer: null,
        placement: { x: 300, y: 8, scale: 1 },
      },
      challenges: [],
    };
    const api: AdminApi = {
      save: vi.fn(),
      setVisibility: vi.fn(),
      getChallengeBoard: vi.fn(() => Promise.resolve(challengeSnapshot)),
      saveChallengeBoard: vi.fn(),
    };

    render(<AdminWorkspace api={api} initialBootstrap={bootstrap()} workspace="challenges" />);

    expect(await screen.findByRole("heading", { name: "Board" })).toBeInTheDocument();
    // Die HUD-Rail bleibt dauerhaft gemountet (kein Remount beim Tab-Wechsel), ist im Challenge-Tab
    // aber per hidden-Attribut auf dem Tabpanel unsichtbar.
    expect(document.querySelector("#admin-composition-panel-hud")).toHaveAttribute("hidden");
    expect(document.querySelector(".editor-rail")).not.toBeVisible();
    expect(screen.getByRole("tab", { name: "HUD" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Challenges" })).toHaveAttribute("aria-selected", "true");
  });

  it("macht den Schalter für Animationen und Töne bedienbar und speichert ihn", async () => {
    const user = userEvent.setup();
    const challengeSnapshot: ChallengeBoardSnapshot = {
      eventSeq: 0,
      boardRevision: 1,
      settingsRevision: 3,
      settings: {
        styleId: "plain-list",
        themeMode: "inherit",
        surfaceOpacity: 100,
        headerStyle: "default",
        fontFamily: "theme",
        fontScale: 1,
        headerTitle: "CHALLENGES",
        penaltyText: "",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end", globalTimerMode: "down",
        globalTimer: null,
        placement: { x: 300, y: 8, scale: 1 },
      },
      challenges: [],
    };
    const saveChallengeSettings = vi.fn(() => Promise.resolve({ snapshot: challengeSnapshot }));
    const api = {
      save: vi.fn(),
      setVisibility: vi.fn(),
      getChallengeBoard: vi.fn(() => Promise.resolve(challengeSnapshot)),
      saveChallengeBoard: vi.fn(),
      saveChallengeSettings,
    };

    render(<AdminWorkspace api={api} initialBootstrap={bootstrap()} workspace="challenges" />);

    const toggle = await screen.findByRole("checkbox", { name: "Animationen und Töne" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    // Die HUD-Rail ist ebenfalls dauerhaft gemountet und hat eigene X/Y/Skalierung-Felder;
    // hier gezielt im sichtbaren Challenge-Tabpanel suchen.
    const challengesPanel = within(document.querySelector("#admin-composition-panel-challenges") as HTMLElement);
    expect(challengesPanel.getByRole("combobox", { name: "Wechseltempo" })).toBeDisabled();
    expect(challengesPanel.getByText("nur bei Blättern/Durchlaufen")).toBeInTheDocument();
    fireEvent.change(challengesPanel.getByRole("combobox", { name: "Listenart" }), { target: { value: "quest-log" } });
    fireEvent.change(challengesPanel.getByLabelText("Titel"), { target: { value: "RUN" } });
    fireEvent.change(challengesPanel.getByLabelText("Strafe"), { target: { value: "Keine Pizza" } });
    fireEvent.change(challengesPanel.getByRole("combobox", { name: "Hintergrund" }), { target: { value: "0" } });
    fireEvent.change(challengesPanel.getByRole("combobox", { name: "Stil" }), { target: { value: "inverted" } });
    fireEvent.change(challengesPanel.getByRole("combobox", { name: "Sichtbare Einträge" }), { target: { value: "8" } });
    expect(challengesPanel.getByRole("combobox", { name: "Bei mehr als 8 Einträgen" })).toBeInTheDocument();
    fireEvent.change(challengesPanel.getByRole("combobox", { name: "Modus" }), { target: { value: "off" } });
    fireEvent.change(challengesPanel.getByRole("combobox", { name: "Modus" }), { target: { value: "down" } });
    fireEvent.change(challengesPanel.getByRole("spinbutton", { name: "Dauer" }), { target: { value: "45" } });
    fireEvent.change(challengesPanel.getByRole("combobox", { name: "Erledigte Einträge" }), { target: { value: "keep" } });
    fireEvent.change(challengesPanel.getByRole("combobox", { name: "Bei mehr als 8 Einträgen" }), { target: { value: "page" } });
    fireEvent.change(challengesPanel.getByRole("combobox", { name: "Wechseltempo" }), { target: { value: "fast" } });
    await user.click(challengesPanel.getByRole("checkbox", { name: "Nummerierung" }));
    fireEvent.change(challengesPanel.getByLabelText("X"), { target: { value: "250" } });
    fireEvent.change(challengesPanel.getByLabelText("Y"), { target: { value: "12" } });
    fireEvent.change(challengesPanel.getByLabelText("Größe"), { target: { value: "1.25" } });
    await user.click(screen.getByRole("button", { name: "Alle speichern" }));

    expect(saveChallengeSettings).toHaveBeenCalledWith(expect.objectContaining({
      baseSettingsRevision: 3,
      effectsEnabled: false,
      styleId: "quest-log",
      surfaceOpacity: 0,
      headerStyle: "inverted",
      headerTitle: "RUN",
      penaltyText: "Keine Pizza",
      maxVisible: 8,
      overflowMode: "page",
      overflowTempo: "fast",
      numbered: true,
      doneOrder: "keep",
      globalTimerMode: "down",
      globalTimerTotalMs: 2_700_000,
      placement: { x: 250, y: 12, scale: 1.25 },
    }));

    fireEvent.change(challengesPanel.getByRole("combobox", { name: "Modus" }), { target: { value: "down" } });
    fireEvent.change(challengesPanel.getByRole("spinbutton", { name: "Dauer" }), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Alle speichern" }));
    expect(await screen.findByText("Für den Modus ‚runterzählen‘ ist eine Dauer erforderlich.")).toBeInTheDocument();
  });

  it("findet alle sieben Darstellungsgruppen über ihre Legende", async () => {
    const challengeSnapshot: ChallengeBoardSnapshot = {
      eventSeq: 0,
      boardRevision: 1,
      settingsRevision: 1,
      settings: {
        styleId: "plain-list", themeMode: "inherit", surfaceOpacity: 100, headerStyle: "default", headerTitle: "CHALLENGES", penaltyText: "", effectsEnabled: true,
        fontFamily: "theme", fontScale: 1,
        maxVisible: 8, overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end", globalTimerMode: "down",
        globalTimer: null, placement: { x: 300, y: 8, scale: 1 },
      },
      challenges: [],
    };
    const api: AdminApi = {
      save: vi.fn(),
      setVisibility: vi.fn(),
      getChallengeBoard: vi.fn(() => Promise.resolve(challengeSnapshot)),
      saveChallengeBoard: vi.fn(),
      saveChallengeSettings: vi.fn(),
    };

    render(<AdminWorkspace api={api} initialBootstrap={bootstrap()} workspace="challenges" />);

    const panel = within(await screen.findByRole("region", { name: "Darstellung" }));
    for (const name of ["Aussehen", "Kopfzeile", "Fußzeile", "Einträge", "Timer", "Position im Stream", "Ereignisse"]) {
      expect(panel.getByRole("group", { name })).toBeInTheDocument();
    }
    expect(panel.getByText("Die Vorschau links zeigt den Entwurf.")).toBeInTheDocument();
  });

  it("verwirft in der Vorschau alte Globaltimer-Laufzeit bei geänderter Dauer", async () => {
    const challengeSnapshot: ChallengeBoardSnapshot = {
      eventSeq: 0,
      boardRevision: 1,
      settingsRevision: 1,
      settings: {
        styleId: "plain-list",
        themeMode: "inherit",
        surfaceOpacity: 100,
        headerStyle: "default",
        fontFamily: "theme",
        fontScale: 1,
        headerTitle: "CHALLENGES",
        penaltyText: "",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end", globalTimerMode: "down",
        globalTimer: { totalMs: 60_000, endsAt: new Date(Date.now() + 60_000).toISOString(), pausedRemainMs: null },
        placement: { x: 300, y: 8, scale: 1 },
      },
      challenges: [],
    };
    const api: AdminApi = {
      save: vi.fn(),
      setVisibility: vi.fn(),
      getChallengeBoard: vi.fn(() => Promise.resolve(challengeSnapshot)),
      saveChallengeBoard: vi.fn(),
      saveChallengeSettings: vi.fn(),
    };

    render(<AdminWorkspace api={api} initialBootstrap={bootstrap()} workspace="challenges" />);
    const timerField = await screen.findByRole("spinbutton", { name: "Dauer" });
    expect(timerField).toBeRequired();
    await waitFor(() => expect(document.querySelector(".challenge-source__timer")).toHaveAttribute("data-state", "running"));

    fireEvent.change(timerField, { target: { value: "2" } });

    await waitFor(() => expect(document.querySelector(".challenge-source__timer")).toBeNull());
  });

  it("setzt einen laufenden globalen Timer ohne Bestätigungsdialog über das Session-Kommando zurück", async () => {
    const user = userEvent.setup();
    const challengeSnapshot: ChallengeBoardSnapshot = {
      eventSeq: 3,
      boardRevision: 1,
      settingsRevision: 1,
      settings: {
        styleId: "plain-list",
        themeMode: "inherit",
        surfaceOpacity: 100,
        headerStyle: "default",
        fontFamily: "theme",
        fontScale: 1,
        headerTitle: "CHALLENGES",
        penaltyText: "",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end", globalTimerMode: "down",
        globalTimer: { totalMs: 60_000, endsAt: new Date(Date.now() + 30_000).toISOString(), pausedRemainMs: null },
        placement: { x: 300, y: 8, scale: 1 },
      },
      challenges: [],
    };
    const sendChallengeCommand = vi.fn((command: Command) => {
      void command;
      return Promise.resolve({
      eventSeq: 4,
      replayed: false,
      settings: challengeSnapshot.settings,
      });
    });
    const api: AdminApi = {
      save: vi.fn(),
      setVisibility: vi.fn(),
      getChallengeBoard: vi.fn(() => Promise.resolve(challengeSnapshot)),
      saveChallengeBoard: vi.fn(),
      saveChallengeSettings: vi.fn(),
      sendChallengeCommand,
    };

    render(<AdminWorkspace api={api} initialBootstrap={bootstrap()} workspace="challenges" />);
    const reset = await screen.findByRole("button", { name: "Globaler Timer zurücksetzen" });
    expect(reset).toBeEnabled();
    await user.click(reset);

    const commandCall = sendChallengeCommand.mock.calls[0];
    if (commandCall === undefined) throw new Error("Reset-Kommando wurde nicht gesendet.");
    const [command] = commandCall;
    expect(command.commandId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(command).toMatchObject({ scope: "global", type: "resetGlobalTimer" });
  });

  it("bietet im Darstellungs-Panel globale Start- und Pause-Kommandos an", async () => {
    const user = userEvent.setup();
    const runningSnapshot: ChallengeBoardSnapshot = {
      eventSeq: 3,
      boardRevision: 1,
      settingsRevision: 1,
      settings: {
        styleId: "plain-list", themeMode: "inherit", surfaceOpacity: 100, headerStyle: "default", headerTitle: "CHALLENGES", penaltyText: "", effectsEnabled: true,
        fontFamily: "theme", fontScale: 1,
        maxVisible: 5, overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end", globalTimerMode: "down",
        globalTimer: { totalMs: 60_000, endsAt: new Date(Date.now() + 30_000).toISOString(), pausedRemainMs: null }, placement: { x: 300, y: 8, scale: 1 },
      },
      challenges: [],
    };
    const sendChallengeCommand = vi.fn((command: Command) => {
      void command;
      return Promise.resolve({ eventSeq: 4, replayed: false, settings: runningSnapshot.settings });
    });
    const api: AdminApi = {
      save: vi.fn(), setVisibility: vi.fn(), getChallengeBoard: vi.fn(() => Promise.resolve(runningSnapshot)),
      saveChallengeBoard: vi.fn(), saveChallengeSettings: vi.fn(), sendChallengeCommand,
    };

    const { unmount } = render(<AdminWorkspace api={api} initialBootstrap={bootstrap()} workspace="challenges" />);
    const pause = await screen.findByRole("button", { name: "Globaler Timer pausieren" });
    await user.click(pause);
    expect(sendChallengeCommand).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "global", type: "pauseGlobalTimer" }));
    unmount();
    cleanup();

    const idleSnapshot: ChallengeBoardSnapshot = {
      ...runningSnapshot,
      settings: { ...runningSnapshot.settings, globalTimer: { totalMs: 60_000, endsAt: null, pausedRemainMs: null } },
    };
    const startCommand = vi.fn((command: Command) => {
      void command;
      return Promise.resolve({ eventSeq: 4, replayed: false, settings: idleSnapshot.settings });
    });
    const startApi: AdminApi = {
      save: vi.fn(), setVisibility: vi.fn(), getChallengeBoard: vi.fn(() => Promise.resolve(idleSnapshot)),
      saveChallengeBoard: vi.fn(), saveChallengeSettings: vi.fn(), sendChallengeCommand: startCommand,
    };
    render(<AdminWorkspace api={startApi} initialBootstrap={bootstrap()} workspace="challenges" />);
    const start = await screen.findByRole("button", { name: "Globaler Timer starten" });
    await user.click(start);
    expect(startCommand).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "global", type: "startGlobalTimer" }));
  });

  it("zeigt beim Hochzählen die Dauer deaktiviert und speichert die 24-Stunden-Kappe", async () => {
    const user = userEvent.setup();
    const challengeSnapshot: ChallengeBoardSnapshot = {
      eventSeq: 0,
      boardRevision: 1,
      settingsRevision: 1,
      settings: {
        styleId: "plain-list",
        themeMode: "inherit",
        surfaceOpacity: 100,
        headerStyle: "default",
        fontFamily: "theme",
        fontScale: 1,
        headerTitle: "CHALLENGES",
        penaltyText: "",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end", globalTimerMode: "down",
        globalTimer: null,
        placement: { x: 300, y: 8, scale: 1 },
      },
      challenges: [],
    };
    const saveChallengeSettings = vi.fn(() => Promise.resolve({ snapshot: challengeSnapshot }));
    const api: AdminApi = {
      save: vi.fn(),
      setVisibility: vi.fn(),
      getChallengeBoard: vi.fn(() => Promise.resolve(challengeSnapshot)),
      saveChallengeBoard: vi.fn(),
      saveChallengeSettings,
    };

    render(<AdminWorkspace api={api} initialBootstrap={bootstrap()} workspace="challenges" />);
    const panel = within(await screen.findByRole("region", { name: "Darstellung" }));
    const minutes = panel.getByRole("spinbutton", { name: "Dauer" });
    expect(minutes).toBeDisabled();
    expect(panel.getByRole("button", { name: "Globaler Timer zurücksetzen" })).toBeDisabled();
    expect(panel.getByText("bereit")).toBeInTheDocument();

    fireEvent.change(panel.getByRole("combobox", { name: "Modus" }), { target: { value: "up" } });
    expect(panel.getByRole("spinbutton", { name: "Dauer" })).toBeDisabled();
    expect(panel.getByText("nur beim Runterzählen")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Alle speichern" }));

    expect(saveChallengeSettings).toHaveBeenCalledWith(expect.objectContaining({
      globalTimerMode: "up",
      globalTimerTotalMs: 86_400_000,
    }));
  });

  it("übernimmt geänderte Settings aus dem Live-Update des Boards", async () => {
    let onChallengeUpdate: ((update: ChallengeUpdate) => void) | undefined;
    const challengeSnapshot: ChallengeBoardSnapshot = {
      eventSeq: 0,
      boardRevision: 1,
      settingsRevision: 3,
      settings: {
        styleId: "plain-list",
        themeMode: "inherit",
        surfaceOpacity: 100,
        headerStyle: "default",
        fontFamily: "theme",
        fontScale: 1,
        headerTitle: "CHALLENGES",
        penaltyText: "",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end", globalTimerMode: "down",
        globalTimer: null,
        placement: { x: 300, y: 8, scale: 1 },
      },
      challenges: [],
    };
    const api: AdminApi = {
      save: vi.fn(),
      setVisibility: vi.fn(),
      getChallengeBoard: vi.fn(() => Promise.resolve(challengeSnapshot)),
      saveChallengeBoard: vi.fn(),
      saveChallengeSettings: vi.fn(),
      subscribe: (callbacks) => {
        onChallengeUpdate = callbacks.onChallengeUpdate;
        return () => undefined;
      },
    };

    render(<AdminWorkspace api={api} initialBootstrap={bootstrap()} workspace="challenges" />);
    const toggle = await screen.findByRole("checkbox", { name: "Animationen und Töne" });

    act(() => {
      onChallengeUpdate?.({
        eventSeq: 1,
        boardRevision: 2,
        settingsRevision: 4,
        settings: { ...challengeSnapshot.settings, themeId: "trail-wood", effectsEnabled: false },
        challenges: [],
        event: null,
      });
    });

    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it("übernimmt bei einem Settings-Konflikt den aktuellen Serverstand für den nächsten Versuch", async () => {
    const user = userEvent.setup();
    const challengeSnapshot: ChallengeBoardSnapshot = {
      eventSeq: 0,
      boardRevision: 1,
      settingsRevision: 3,
      settings: {
        styleId: "plain-list",
        themeMode: "inherit",
        surfaceOpacity: 100,
        headerStyle: "default",
        fontFamily: "theme",
        fontScale: 1,
        headerTitle: "CHALLENGES",
        penaltyText: "",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end", globalTimerMode: "down",
        globalTimer: null,
        placement: { x: 300, y: 8, scale: 1 },
      },
      challenges: [],
    };
    const currentSnapshot = {
      ...challengeSnapshot,
      settingsRevision: 4,
      settings: { ...challengeSnapshot.settings, effectsEnabled: true },
    };
    const saveChallengeSettings = vi.fn()
      .mockRejectedValueOnce({ code: "revision_conflict", currentSnapshot })
      .mockResolvedValueOnce({ snapshot: { ...currentSnapshot, settingsRevision: 5, settings: { ...currentSnapshot.settings, effectsEnabled: false } } });
    const api = {
      save: vi.fn(),
      setVisibility: vi.fn(),
      getChallengeBoard: vi.fn(() => Promise.resolve(challengeSnapshot)),
      saveChallengeBoard: vi.fn(),
      saveChallengeSettings,
    };

    render(<AdminWorkspace api={api} initialBootstrap={bootstrap()} workspace="challenges" />);

    const toggle = await screen.findByRole("checkbox", { name: "Animationen und Töne" });
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Alle speichern" }));
    // Die Meldung erscheint sowohl im Modul selbst als auch (mit Modulnamen versehen) in
    // der globalen Speicherleiste – gezielt im Modul selbst suchen.
    const settingsPanel = document.querySelector(".challenge-settings-panel") as HTMLElement;
    expect(await within(settingsPanel).findByText(/Serverstand ist übernommen/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Alle speichern" }));
    expect(saveChallengeSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      baseSettingsRevision: 4,
      effectsEnabled: false,
    }));
  });

  // Regressionsschutz zu einem Review-Befund: die globale Speicherleiste ruft dasselbe
  // save() wie der modul-eigene Button auf (per Ref-Griff), darum wird der mitgelieferte
  // Serverstand aus einem revision_conflict bereits dort übernommen – die Leiste muss
  // nichts Eigenes damit tun, nur zum Tab mit der Konfliktanzeige wechseln.
  it("übernimmt bei einem Settings-Konflikt über die globale Speicherleiste den aktuellen Serverstand", async () => {
    const user = userEvent.setup();
    const challengeSnapshot: ChallengeBoardSnapshot = {
      eventSeq: 0,
      boardRevision: 1,
      settingsRevision: 3,
      settings: {
        styleId: "plain-list",
        themeMode: "inherit",
        surfaceOpacity: 100,
        headerStyle: "default",
        fontFamily: "theme",
        fontScale: 1,
        headerTitle: "CHALLENGES",
        penaltyText: "",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end", globalTimerMode: "down",
        globalTimer: null,
        placement: { x: 300, y: 8, scale: 1 },
      },
      challenges: [],
    };
    const currentSnapshot = {
      ...challengeSnapshot,
      settingsRevision: 7,
      settings: { ...challengeSnapshot.settings, effectsEnabled: true },
    };
    const saveChallengeSettings = vi.fn()
      .mockRejectedValueOnce({ code: "revision_conflict", currentSnapshot })
      .mockResolvedValueOnce({ snapshot: { ...currentSnapshot, settingsRevision: 8, settings: { ...currentSnapshot.settings, effectsEnabled: false } } })
      .mockRejectedValueOnce("Speichern kaputt");
    const api: AdminApi = {
      save: vi.fn(),
      setVisibility: vi.fn(),
      getChallengeBoard: vi.fn(() => Promise.resolve(challengeSnapshot)),
      saveChallengeBoard: vi.fn(),
      saveChallengeSettings,
    };

    render(<AdminWorkspace api={api} initialBootstrap={bootstrap()} />);
    await user.click(screen.getByRole("tab", { name: "Challenges" }));
    const toggle = await screen.findByRole("checkbox", { name: "Animationen und Töne" });
    await user.click(toggle);
    await user.click(screen.getByRole("tab", { name: "HUD" }));

    await user.click(await screen.findByRole("button", { name: "Alle speichern" }));
    await waitFor(() => expect(saveChallengeSettings).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("tab", { name: "Challenges" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("button", { name: "Alle speichern" }));
    expect(saveChallengeSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      baseSettingsRevision: 7,
    }));

    await user.click(screen.getByRole("checkbox", { name: "Animationen und Töne" }));
    await user.click(screen.getByRole("button", { name: "Alle speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Challenge-Einstellungen konnten nicht gespeichert werden.");
  });

  it("zeigt bei einem Board-Konflikt über die globale Speicherleiste die modul-eigene Konflikt-UI mit Serverstand", async () => {
    const user = userEvent.setup();
    const localChallenge: ChallengeBoardSnapshot["challenges"][number] = { id: "one", title: "Lokaler Entwurf", targetCount: null, timerTotalMs: null, sortOrder: 0, hidden: false, currentCount: 0, state: "pending", timerEndsAt: null, timerRemainMs: null, completedAt: null, createdAt: "2026-08-31T10:00:00.000Z", updatedAt: "2026-08-31T10:00:00.000Z" };
    const challengeSnapshot: ChallengeBoardSnapshot = {
      eventSeq: 0,
      boardRevision: 1,
      settingsRevision: 1,
      settings: {
        styleId: "plain-list",
        themeMode: "inherit",
        surfaceOpacity: 100,
        headerStyle: "default",
        fontFamily: "theme",
        fontScale: 1,
        headerTitle: "CHALLENGES",
        penaltyText: "",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end", globalTimerMode: "down",
        globalTimer: null,
        placement: { x: 300, y: 8, scale: 1 },
      },
      challenges: [localChallenge],
    };
    const foreignSnapshot: ChallengeBoardSnapshot = { ...challengeSnapshot, boardRevision: 2, challenges: [{ ...localChallenge, title: "Fremde Änderung" }] };
    const saveChallengeBoard = vi.fn().mockRejectedValueOnce({ code: "revision_conflict", currentSnapshot: foreignSnapshot });
    const api: AdminApi = {
      save: vi.fn(),
      setVisibility: vi.fn(),
      getChallengeBoard: vi.fn(() => Promise.resolve(challengeSnapshot)),
      saveChallengeBoard,
      saveChallengeSettings: vi.fn(),
    };

    render(<AdminWorkspace api={api} initialBootstrap={bootstrap()} />);
    await user.click(screen.getByRole("tab", { name: "Challenges" }));
    const title = await screen.findByDisplayValue("Lokaler Entwurf");
    await user.clear(title);
    await user.type(title, "Mein Entwurf");
    await user.click(screen.getByRole("tab", { name: "HUD" }));

    await user.click(await screen.findByRole("button", { name: "Alle speichern" }));
    await waitFor(() => expect(saveChallengeBoard).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("tab", { name: "Challenges" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Jemand anderes hat das Board gespeichert.")).toBeInTheDocument();
    expect(screen.getByText("Fremde Änderung")).toBeInTheDocument();
  });

  // Review-Befund: eine verspätete (aber erfolgreiche) Save-Antwort für eine ältere
  // Revision darf einen inzwischen per Socket eingetroffenen neueren Stand nicht
  // zurückdrehen. applyRemoteSnapshot schützt Socket-Snapshots bereits mit einem
  // Revisions-Guard; save() muss dieselbe Regel auf die eigene Antwort anwenden.
  it("verwirft eine verspätete Save-Antwort gegenüber einer inzwischen per Socket eingetroffenen neueren Revision", async () => {
    const user = userEvent.setup();
    let onChallengeUpdate: ((update: ChallengeUpdate) => void) | undefined;
    const challengeSnapshot: ChallengeBoardSnapshot = {
      eventSeq: 0,
      boardRevision: 1,
      settingsRevision: 3,
      settings: {
        styleId: "plain-list",
        themeMode: "inherit",
        surfaceOpacity: 100,
        headerStyle: "default",
        fontFamily: "theme",
        fontScale: 1,
        headerTitle: "CHALLENGES",
        penaltyText: "",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end", globalTimerMode: "down",
        globalTimer: null,
        placement: { x: 300, y: 8, scale: 1 },
      },
      challenges: [],
    };
    let resolveSave: ((value: { snapshot: ChallengeBoardSnapshot }) => void) | undefined;
    const saveChallengeSettings = vi.fn(() => new Promise<{ snapshot: ChallengeBoardSnapshot }>((resolve) => { resolveSave = resolve; }));
    const api: AdminApi = {
      save: vi.fn(),
      setVisibility: vi.fn(),
      getChallengeBoard: vi.fn(() => Promise.resolve(challengeSnapshot)),
      saveChallengeBoard: vi.fn(),
      saveChallengeSettings,
      subscribe: (callbacks) => { onChallengeUpdate = callbacks.onChallengeUpdate; return () => undefined; },
    };

    render(<AdminWorkspace api={api} initialBootstrap={bootstrap()} workspace="challenges" />);
    const toggle = await screen.findByRole("checkbox", { name: "Animationen und Töne" });
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Alle speichern" }));
    await waitFor(() => expect(saveChallengeSettings).toHaveBeenCalledTimes(1));

    // Während unsere eigene Antwort noch unterwegs ist, trifft per Socket eine neuere
    // Revision ein (z.B. von einem zweiten Editor) – settingsRevision 4 statt unserer 3.
    act(() => {
      onChallengeUpdate?.({
        eventSeq: 1,
        boardRevision: 1,
        settingsRevision: 4,
        settings: {
          ...challengeSnapshot.settings,
          themeId: "trail-wood",
          effectsEnabled: false,
          globalTimer: { totalMs: 60_000, endsAt: "2000-01-01T00:00:00.000Z", pausedRemainMs: null },
        },
        challenges: [],
        event: null,
      });
    });
    expect(await screen.findByText("abgelaufen")).toBeInTheDocument();

    act(() => {
      onChallengeUpdate?.({
        eventSeq: 2,
        boardRevision: 1,
        settingsRevision: 5,
        settings: {
          ...challengeSnapshot.settings,
          themeId: "trail-wood",
          globalTimer: { totalMs: 60_000, endsAt: null, pausedRemainMs: 30_000 },
        },
        challenges: [],
        event: null,
      });
    });
    expect(await screen.findByText(/pausiert/)).toBeInTheDocument();

    act(() => {
      onChallengeUpdate?.({
        eventSeq: 3,
        boardRevision: 1,
        settingsRevision: 6,
        settings: {
          ...challengeSnapshot.settings,
          themeId: "trail-wood",
          globalTimerMode: "up",
          globalTimer: { totalMs: 60_000, endsAt: "2000-01-01T00:00:00.000Z", pausedRemainMs: null },
        },
        challenges: [],
        event: null,
      });
    });
    expect(await screen.findByText("1:00")).toBeInTheDocument();

    // Jetzt kommt die verspätete Antwort für unseren (jetzt veralteten) Request rein –
    // mit einer niedrigeren Revision als der bereits bekannte Socket-Stand.
    resolveSave?.({ snapshot: { ...challengeSnapshot, settingsRevision: 2, settings: { ...challengeSnapshot.settings, effectsEnabled: false } } });
    expect(await screen.findByText("Einstellung veröffentlicht.")).toBeInTheDocument();

    // Der nächste Save muss auf der neueren (per Socket erhaltenen) Revision 6 aufsetzen,
    // nicht auf der veralteten Revision 2 aus der verspäteten Antwort.
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Alle speichern" }));
    await waitFor(() => expect(saveChallengeSettings).toHaveBeenCalledTimes(2));
    expect(saveChallengeSettings).toHaveBeenLastCalledWith(expect.objectContaining({ baseSettingsRevision: 6 }));
  });
});

describe("Admin workspace setup", () => {
  it("zeigt drei Quellen, kopiert verdeckte URLs und erzeugt den QR-Code erst nach dem Aufdecken", async () => {
    const user = userEvent.setup();
    const overlayToken = "O".repeat(43);
    const dockToken = "D".repeat(43);
    const initial = bootstrap();
    initial.capsule.overlayToken = {
      exists: true,
      generation: 2,
      createdAt: "2026-08-29T12:00:00.000Z",
      lastUsedAt: null,
      connectedSockets: 0,
      token: overlayToken,
    };
    initial.capsule.dockToken = {
      exists: true,
      generation: 3,
      fingerprint: "ABCDEF12",
      createdAt: "2026-08-29T12:00:00.000Z",
      lastUsedAt: null,
      connectedSockets: 0,
      token: dockToken,
    };
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const challengeSnapshot: ChallengeBoardSnapshot = {
      eventSeq: 0,
      boardRevision: 1,
      settingsRevision: 1,
      settings: {
        styleId: "plain-list",
        themeMode: "inherit",
        surfaceOpacity: 100,
        headerStyle: "default",
        fontFamily: "theme",
        fontScale: 1,
        headerTitle: "CHALLENGES",
        penaltyText: "",
        effectsEnabled: true,
        maxVisible: 5,
        overflowMode: "cut", overflowTempo: "medium", numbered: false, doneOrder: "end", globalTimerMode: "down",
        globalTimer: null,
        placement: { x: 300, y: 8, scale: 1 },
      },
      challenges: [],
    };

    render(<AdminWorkspace
      api={{
        save: vi.fn(),
        setVisibility: vi.fn(),
        getChallengeBoard: vi.fn(() => Promise.resolve(challengeSnapshot)),
        saveChallengeBoard: vi.fn(),
      }}
      initialBootstrap={initial}
      workspace="challenges"
    />);

    const setupToggle = screen.getByRole("button", { name: "OBS-Einrichtung öffnen" });
    expect(setupToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "HUD-Overlay" })).not.toBeInTheDocument();
    await user.click(setupToggle);
    expect(setupToggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("heading", { name: "HUD-Overlay" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Challenge-Log" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "HUD + Challenge-Log" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Live-Bedienseite" })).toBeInTheDocument();
    expect(screen.getAllByText("1920 × 1080 px")).toHaveLength(3);
    expect(screen.getByText("mindestens 280 px breit; Höhe nach Inhalt")).toBeInTheDocument();
    expect(screen.getByText(/View → Docks → Custom Browser Docks/)).toBeInTheDocument();
    expect(screen.getByText("Browser-Docks stehen unter Wayland nicht zur Verfügung.")).toBeInTheDocument();
    expect(screen.getByText(/eigenes Cookie-Profil/)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "QR-Code für die Live-Bedienseite" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(dockToken);

    await user.click(setupToggle);
    expect(setupToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "HUD-Overlay" })).not.toBeInTheDocument();
    await user.click(setupToggle);

    await user.click(screen.getByRole("button", { name: "HUD-Overlay-URL kopieren" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/overlay#token=${overlayToken}`);
    expect(screen.getByRole("button", { name: "HUD-Overlay-URL kopieren" })).toHaveTextContent("Kopiert");

    await user.click(screen.getByRole("button", { name: "URLs anzeigen" }));
    expect(screen.getByText(`${window.location.origin}/live/challenges#token=${dockToken}`)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "QR-Code für die Live-Bedienseite" })).toBeInTheDocument();
    expect(screen.getByText(/QR-Code nicht im Stream zeigen/)).toBeInTheDocument();
  });
});

describe("Admin workspace publication boundary", () => {
  it("kopiert einen wiederherstellbaren Bootstrap-Token ohne vorherige Erzeugung", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    initial.capsule.overlayToken = {
      exists: true,
      generation: 1,
      createdAt: "2026-08-29T12:00:00.000Z",
      lastUsedAt: null,
      connectedSockets: 0,
      token: "C".repeat(43),
    };
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    render(<AdminWorkspace initialBootstrap={initial} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
    }} />);

    const copyButton = screen.getByRole("button", { name: "OBS-Link kopieren" });
    expect(copyButton).toBeEnabled();
    await user.click(copyButton);
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/overlay/all#token=${"C".repeat(43)}`);
  });

  it("macht den Hinweis zu einem vorhandenen Alt-Token ohne Envelope erreichbar", () => {
    const initial = bootstrap();
    initial.capsule.overlayToken = {
      exists: true,
      generation: 1,
      createdAt: "2026-08-29T12:00:00.000Z",
      lastUsedAt: null,
      connectedSockets: 0,
      token: null,
    };

    render(<AdminWorkspace initialBootstrap={initial} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
    }} />);

    const copyButton = screen.getByRole("button", { name: "OBS-Link kopieren" });
    expect(copyButton).toBeEnabled();
    expect(copyButton).toHaveAttribute("aria-disabled", "true");
    expect(copyButton).toHaveAttribute(
      "title",
      "Dieser alte Token ist nicht wiederherstellbar. Bitte einen neuen Token erzeugen.",
    );
    expect(copyButton).toHaveAccessibleDescription(
      "Dieser alte Token ist nicht wiederherstellbar. Bitte einen neuen Token erzeugen.",
    );
  });

  it("zooms the live preview through 200 percent and resets without creating a publishable change", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
    }} />);

    const zoom = screen.getByRole("slider", { name: "Vorschau-Zoom" });
    const previewPanel = screen.getByRole("heading", { name: "Live-Vorschau" }).closest("section");
    const previewStage = previewPanel?.querySelector(".preview-stage");
    expect(zoom).toHaveValue("100");
    expect(zoom).toHaveAttribute("max", "200");
    expect(previewPanel).not.toHaveStyle({ maxWidth: "980px" });
    expect(previewStage).toHaveStyle({ width: "100%" });
    expect(screen.getByRole("button", { name: "Vorschau-Zoom auf 100 % zurücksetzen" })).toBeDisabled();

    fireEvent.change(zoom, { target: { value: "200" } });

    expect(screen.getByText("200%", { selector: "output" })).toBeInTheDocument();
    expect(previewStage).toHaveStyle({ width: "200%" });
    // Kein modul-eigener Button mehr: die globale Speicherleiste existiert erst gar
    // nicht, solange nichts dirty ist (Zoom ist keine Draft-Änderung).
    expect(screen.queryByRole("button", { name: "Alle speichern" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Vorschau-Zoom auf 100 % zurücksetzen" }));
    expect(zoom).toHaveValue("100");
    expect(previewStage).toHaveStyle({ width: "100%" });
  });

  it("maps resource presets to canonical colors and exposes the picker only for Custom", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
    }} />);

    await user.click(screen.getByText("Einrichten").closest("summary") as HTMLElement);
    const resource = screen.getByRole("combobox", { name: "Ressource" });
    expect(resource).toHaveValue("Energie");
    expect(screen.queryByLabelText("Eigene Farbe")).not.toBeInTheDocument();

    await user.selectOptions(resource, "Wut");
    const rageMeter = screen.getByRole("meter", { name: "Wut 0 Prozent" });
    expect((rageMeter.querySelector(".hud-bar-fill") as HTMLElement).style.getPropertyValue("--bar-color")).toBe("#FF0000");
    expect(screen.queryByLabelText("Eigene Farbe")).not.toBeInTheDocument();

    await user.selectOptions(resource, "Custom");
    const customColor = screen.getByLabelText("Eigene Farbe");
    expect(customColor).toHaveValue("#ff0000");
    fireEvent.change(customColor, { target: { value: "#123456" } });
    const customMeter = screen.getByRole("meter", { name: "Eigene Ressource 0 Prozent" });
    expect((customMeter.querySelector(".hud-bar-fill") as HTMLElement).style.getPropertyValue("--bar-color")).toBe("#123456");
  });

  it("preserves existing custom resource values without marking the draft dirty", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    initial.state.player.resource = { name: "Fokus", color: "#123456", percent: 42 };
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
    }} />);

    await user.click(screen.getByText("Einrichten").closest("summary") as HTMLElement);
    expect(screen.getByRole("combobox", { name: "Ressource" })).toHaveValue("Custom");
    expect(screen.getByLabelText("Eigene Farbe")).toHaveValue("#123456");
    // Kein modul-eigener Button mehr: die globale Speicherleiste erscheint gar nicht,
    // solange nichts wirklich dirty ist.
    expect(screen.queryByRole("button", { name: "Alle speichern" })).not.toBeInTheDocument();
  });

  it("toggles pet and group visibility in the draft without collapsing their sections", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    const guest = {
      id: "guest-1",
      source: "manual" as const,
      twitchUserId: null,
      name: "Gast",
      portrait: { kind: "initials" as const, text: "GA" },
      hpPercent: 100,
    };
    initial.state = {
      ...initial.state,
      pet: {
        name: "Begleiter",
        subtitle: null,
        portrait: { kind: "initials", text: "BE" },
        hpPercent: 100,
      },
      group: [guest],
    };
    const save = vi.fn<AdminApi["save"]>((request) => Promise.resolve({
      state: {
        ...initial.state,
        ...request.state,
        revision: 2,
        updatedAt: "2026-08-29T12:01:00.000Z",
      },
      auditEntry: {
        id: "audit-visibility",
        revision: 2,
        action: "save",
        actor,
        summary: "Sichtbarkeit geändert",
        createdAt: "2026-08-29T12:01:00.000Z",
      },
      undoTargets: [],
      serverTime: "2026-08-29T12:01:00.000Z",
    }));
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save,
      setVisibility: () => Promise.resolve({ state: initial.state, auditEntry: null, undoTargets: [], serverTime: initial.serverTime }),
    }} />);

    const petToggle = screen.getByRole("switch", { name: "Pet im Overlay anzeigen" });
    const groupToggle = screen.getByRole("switch", { name: "Gruppe im Overlay anzeigen" });
    const petSection = petToggle.closest("details") as HTMLDetailsElement;
    const groupSection = groupToggle.closest("details") as HTMLDetailsElement;

    await user.click(petToggle);
    expect(petToggle).toHaveAttribute("aria-checked", "false");
    expect(petSection.open).toBe(true);
    expect(petSection).toHaveTextContent("ausgeblendet");

    await user.click(groupToggle);
    expect(groupToggle).toHaveAttribute("aria-checked", "false");
    expect(groupSection.open).toBe(true);
    expect(groupSection).toHaveTextContent("ausgeblendet");

    petToggle.focus();
    await user.keyboard("{Enter}");
    expect(petToggle).toHaveAttribute("aria-checked", "true");
    expect(petSection.open).toBe(true);
    await user.keyboard(" ");
    expect(petToggle).toHaveAttribute("aria-checked", "false");
    expect(petSection.open).toBe(true);

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Alle speichern" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Alle speichern" }));
    expect(save.mock.calls[0]?.[0].state).toMatchObject({
      pet: { name: "Begleiter" },
      group: [guest],
      petVisible: false,
      groupVisible: false,
    });
  });

  it("keeps pet deletion destructive and labels it as deletion", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    initial.state = {
      ...initial.state,
      pet: {
        name: "Begleiter",
        subtitle: null,
        portrait: { kind: "initials", text: "BE" },
        hpPercent: 100,
      },
    };
    const save = vi.fn<AdminApi["save"]>((request) => Promise.resolve({
      state: {
        ...initial.state,
        ...request.state,
        revision: 2,
        updatedAt: "2026-08-29T12:01:00.000Z",
      },
      auditEntry: {
        id: "audit-delete",
        revision: 2,
        action: "save",
        actor,
        summary: "Pet gelöscht",
        createdAt: "2026-08-29T12:01:00.000Z",
      },
      undoTargets: [],
      serverTime: "2026-08-29T12:01:00.000Z",
    }));
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save,
      setVisibility: () => Promise.resolve({ state: initial.state, auditEntry: null, undoTargets: [], serverTime: initial.serverTime }),
    }} />);

    expect(screen.getByRole("button", { name: "Pet löschen" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pet ausblenden" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pet löschen" }));
    expect(screen.queryByRole("switch", { name: "Pet im Overlay anzeigen" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Alle speichern" }));
    expect(save.mock.calls[0]?.[0].state.pet).toBeNull();
  });

  it("hides the group visibility switch while no guests are configured", () => {
    const initial = bootstrap();
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save: vi.fn(),
      setVisibility: () => Promise.resolve({ state: initial.state, auditEntry: null, undoTargets: [], serverTime: initial.serverTime }),
    }} />);

    expect(screen.queryByRole("switch", { name: "Gruppe im Overlay anzeigen" })).not.toBeInTheDocument();
    expect(screen.getByText("Keine Gäste im Stream.")).toBeInTheDocument();
  });

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

    expect(screen.getByText("Beispielkanal")).toBeInTheDocument();

    const hp = screen.getByRole("slider", { name: "Gesundheit" });
    fireEvent.change(hp, { target: { value: "42" } });

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText("Noch nicht an OBS gesendet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alle speichern" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Alle speichern" }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].state.player.hpPercent).toBe(42);
    expect(save.mock.calls[0]?.[0].state).not.toHaveProperty("overlayEnabled");

    vi.spyOn(window, "confirm").mockReturnValue(true);
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
    await user.click(screen.getByRole("button", { name: "Alle speichern" }));

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("inzwischen geändert");

    await user.click(screen.getByRole("button", { name: "Meinen Entwurf veröffentlichen" }));
    const request = save.mock.calls[0]?.[0];
    expect(request?.baseRevision).toBe(1);
    expect(request?.replaceRevision).toBe(2);
    expect(request?.state.player.hpPercent).toBe(42);
  });

  it("shows the live OBS connection count pushed over the realtime channel instead of a stale zero", async () => {
    const initial = bootstrap();
    let onOverlayPresence: ((connectedSockets: number) => void) | undefined;
    const api: AdminApi = {
      save: vi.fn(),
      setVisibility: () => Promise.resolve({ state: initial.state, auditEntry: null, undoTargets: [], serverTime: initial.serverTime }),
      subscribe: (callbacks) => {
        onOverlayPresence = callbacks.onOverlayPresence;
        return () => undefined;
      },
    };
    render(<AdminWorkspace initialBootstrap={initial} api={api} />);

    expect(screen.getByText("kein Link")).toBeInTheDocument();

    act(() => onOverlayPresence?.(1));

    expect(await screen.findByText("1 verbunden")).toBeInTheDocument();
    expect(screen.queryByText("kein Link")).not.toBeInTheDocument();
  });

  it("zählt neue Audit-Einträge im geschlossenen Rail und leert den Zähler beim Öffnen", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    let onAudit: ((entry: AuditEntry, targets: UndoTarget[]) => void) | undefined;
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
      subscribe: (callbacks) => {
        onAudit = callbacks.onAudit;
        return () => undefined;
      },
    }} />);

    const railToggle = auditToggle();
    expect(railToggle).toHaveAttribute("aria-expanded", "false");
    const makeEntry = (id: string, revision: number): AuditEntry => ({
      id,
      revision,
      action: "save",
      actor,
      summary: id,
      createdAt: "2026-08-29T12:01:00.000Z",
    });
    act(() => {
      onAudit?.(makeEntry("Neue Änderung 1", 2), []);
      onAudit?.(makeEntry("Neue Änderung 2", 3), []);
    });

    expect(screen.getByText("2", { selector: ".audit-new-badge" })).toHaveAttribute("aria-label", "2 neue Einträge");
    await user.click(railToggle);
    expect(railToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("2", { selector: ".audit-new-badge" })).not.toBeInTheDocument();
  });

  it("deduplicates the same audit entry regardless of response and broadcast order", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    const auditEntry: AuditEntry = {
      id: "audit-live",
      revision: 2,
      action: "save",
      actor,
      summary: "Live gespeichert",
      createdAt: "2026-08-29T12:01:00.000Z",
    };
    const undoTargets: UndoTarget[] = [{
      revision: 1,
      createdAt: "2026-08-29T12:00:00.000Z",
      summary: "Startzustand",
    }];
    let onAudit: ((entry: AuditEntry, targets: UndoTarget[]) => void) | undefined;
    const save = vi.fn<AdminApi["save"]>((request) => Promise.resolve({
      state: {
        ...initial.state,
        ...request.state,
        revision: 2,
        updatedAt: auditEntry.createdAt,
      },
      auditEntry,
      undoTargets,
      serverTime: auditEntry.createdAt,
    }));
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save,
      setVisibility: vi.fn(),
      subscribe: (callbacks) => {
        onAudit = callbacks.onAudit;
        return () => undefined;
      },
    }} />);

    // Der Broadcast kann vor der HTTP-Antwort des auslösenden Saves eintreffen.
    if (onAudit === undefined) throw new Error("expected onAudit subscription callback");
    act(() => onAudit?.(auditEntry, undoTargets));
    fireEvent.change(screen.getByRole("slider", { name: "Gesundheit" }), { target: { value: "42" } });
    await user.click(screen.getByRole("button", { name: "Alle speichern" }));
    // Danach kann er erneut eintreffen, obwohl die Antwort den Rail schon befüllt hat.
    act(() => onAudit?.(auditEntry, undoTargets));

    await user.click(auditToggle());
    expect(screen.getAllByText(auditEntry.summary)).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Rev\. 1/ })).toBeInTheDocument();
  });

  it("updates undo targets from history broadcasts without changing a local draft", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    const undoTargets: UndoTarget[] = [{
      revision: 1,
      createdAt: "2026-08-29T12:00:00.000Z",
      summary: "Startzustand",
    }];
    let onUndoTargets: ((targets: UndoTarget[]) => void) | undefined;
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
      subscribe: (callbacks) => {
        onUndoTargets = callbacks.onUndoTargets;
        return () => undefined;
      },
    }} />);

    fireEvent.change(screen.getByRole("slider", { name: "Gesundheit" }), { target: { value: "42" } });
    if (onUndoTargets === undefined) throw new Error("expected onUndoTargets subscription callback");
    act(() => onUndoTargets?.(undoTargets));

    expect(screen.getByRole("slider", { name: "Gesundheit" })).toHaveValue("42");
    await user.click(auditToggle());
    expect(screen.getByRole("button", { name: /Rev\. 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alle speichern" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps newer undo targets when an older save response arrives late", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    const oldAuditEntry: AuditEntry = {
      id: "audit-old",
      revision: 2,
      action: "save",
      actor,
      summary: "Alte Antwort",
      createdAt: "2026-08-29T12:01:00.000Z",
    };
    const newAuditEntry: AuditEntry = {
      id: "audit-new",
      revision: 3,
      action: "save",
      actor,
      summary: "Neue Nachricht",
      createdAt: "2026-08-29T12:02:00.000Z",
    };
    const oldUndoTargets: UndoTarget[] = [{
      revision: 1,
      createdAt: "2026-08-29T12:00:00.000Z",
      summary: "Altes Ziel",
    }];
    const newUndoTargets: UndoTarget[] = [{
      revision: 2,
      createdAt: "2026-08-29T12:01:00.000Z",
      summary: "Neues Ziel",
    }];
    let onAudit: ((entry: AuditEntry, targets: UndoTarget[]) => void) | undefined;
    let resolveSave: ((response: SaveResponse) => void) | undefined;
    const save = vi.fn<AdminApi["save"]>(() => new Promise((resolve) => {
      resolveSave = resolve;
    }));
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save,
      setVisibility: vi.fn(),
      subscribe: (callbacks) => {
        onAudit = callbacks.onAudit;
        return () => undefined;
      },
    }} />);

    fireEvent.change(screen.getByRole("slider", { name: "Gesundheit" }), { target: { value: "42" } });
    await user.click(screen.getByRole("button", { name: "Alle speichern" }));
    if (onAudit === undefined || resolveSave === undefined) throw new Error("expected live callbacks");
    act(() => onAudit?.(newAuditEntry, newUndoTargets));
    await act(async () => {
      resolveSave?.({
        state: { ...initial.state, revision: 2, updatedAt: oldAuditEntry.createdAt },
        auditEntry: oldAuditEntry,
        undoTargets: oldUndoTargets,
        serverTime: oldAuditEntry.createdAt,
      });
      await Promise.resolve();
    });

    await user.click(auditToggle());
    expect(screen.getByRole("button", { name: /Rev\. 2/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Rev\. 1/ })).not.toBeInTheDocument();
  });

  it("verwaltet OBS-Link, Präsenz und die sichere Ausschaltabfrage im Header", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    let onOverlayPresence: ((connectedSockets: number) => void) | undefined;
    const mutateOverlayToken = vi.fn<NonNullable<AdminApi["mutateOverlayToken"]>>((rotate, request) => Promise.resolve({
      requestId: request.requestId,
      generation: rotate ? 2 : 1,
      fingerprint: "ABCDEF12",
      createdAt: "2026-08-29T12:00:00.000Z",
      token: "A".repeat(43),
    }));
    const setVisibility = vi.fn<AdminApi["setVisibility"]>();
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save: vi.fn(),
      setVisibility,
      mutateOverlayToken,
      subscribe: (callbacks) => {
        onOverlayPresence = callbacks.onOverlayPresence;
        return () => undefined;
      },
    }} />);

    const copyButton = screen.getByRole("button", { name: "OBS-Link kopieren" });
    expect(copyButton).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "OBS-Link erzeugen" }));
    expect(screen.getByText("nicht verbunden")).toBeInTheDocument();
    expect(screen.queryByText("keine OBS-Verbindung")).not.toBeInTheDocument();
    const obsChip = screen.getByRole("group", { name: "OBS-Verbindung: nicht verbunden" });
    expect(obsChip).toHaveAttribute("title", "OBS-Verbindung: nicht verbunden");
    expect(copyButton).toBeEnabled();
    await user.click(copyButton);
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/overlay/all#token=${"A".repeat(43)}`);

    await user.click(screen.getByRole("button", { name: "OBS-Einrichtung öffnen" }));
    expect(await screen.findByRole("heading", { name: "Alle Quellen auf einen Blick" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "HUD-Overlay-URL kopieren" }));
    expect(writeText).toHaveBeenLastCalledWith(`${window.location.origin}/overlay#token=${"A".repeat(43)}`);

    act(() => onOverlayPresence?.(2));
    expect(await screen.findByText("2 verbunden")).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Overlay aktiv" }));
    expect(confirm).toHaveBeenCalledWith("Overlay in OBS sofort ausblenden? Zuschauer sehen das HUD dann nicht mehr.");
    expect(setVisibility).not.toHaveBeenCalled();
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
      token: null,
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
      token: "B".repeat(43),
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

    await user.click(auditToggle());
    expect(screen.getAllByText("Startzustand")).toHaveLength(2);
    await user.click(screen.getByText("Einrichten").closest("summary") as HTMLElement);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Live-Charakter" } });
    fireEvent.change(screen.getByLabelText("Titel"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "31" } });
    await user.selectOptions(screen.getByLabelText("Ressource"), "Fokus");
    await user.click(screen.getByRole("button", { name: "Modern Compact" }));
    fireEvent.change(screen.getByLabelText("X"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Y"), { target: { value: "30" } });
    await user.selectOptions(screen.getByLabelText("Skalierung"), "2");

    await user.click(screen.getByRole("button", { name: "Pet einrichten" }));
    const companionHealth = screen.getByRole("slider", { name: "Begleiter Gesundheit" });
    fireEvent.change(companionHealth, { target: { value: "80" } });
    const companionName = companionHealth.closest(".editor-section")?.querySelector('input[maxlength="32"]');
    expect(companionName).toBeDefined();
    fireEvent.change(companionName as HTMLElement, { target: { value: "Wegbegleiter" } });
    fireEvent.change(screen.getByLabelText("Unterzeile"), { target: { value: "Spürhund" } });

    const guestInput = screen.getByLabelText("Twitch-Login oder Name");
    await user.type(guestInput, "Normalo Gast");
    await user.click(screen.getByRole("button", { name: "Als Gast hinzufügen" }));
    await user.type(guestInput, "gast_tv");
    await user.click(screen.getByRole("button", { name: "Auf Twitch suchen" }));
    expect(await screen.findByText("@gast_tv")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hinzufügen" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    expect(await screen.findAllByText("GastTV")).toHaveLength(2);
    expect(lookupTwitchUser).toHaveBeenCalledWith("gast_tv");
    fireEvent.change(screen.getByRole("slider", { name: "Normalo Gast Gesundheit" }), { target: { value: "70" } });
    await user.click(screen.getByRole("button", { name: "Normalo Gast entfernen" }));

    await user.click(screen.getByRole("button", { name: /Effekt hinzufügen/ }));
    await user.click(screen.getByRole("button", { name: "Gestärkt" }));
    await user.click(screen.getByRole("checkbox", { name: "Endet zu einer festen Uhrzeit" }));
    await user.click(screen.getByRole("checkbox", { name: "Beschreibung im Overlay anzeigen" }));
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    expect(screen.getByText("Bereit für das nächste Abenteuer.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "OBS-Link erzeugen" }));
    expect(mutateOverlayToken).toHaveBeenCalledWith(false, expect.objectContaining({ expectedGeneration: 0 }));
    await user.click(screen.getByRole("button", { name: /Neuen Token erzeugen/ }));
    expect(mutateOverlayToken).toHaveBeenLastCalledWith(true, expect.objectContaining({ expectedGeneration: 1 }));

    await user.click(screen.getByRole("button", { name: "Alle speichern" }));
    expect(save.mock.calls[0]?.[0].state).toMatchObject({
      themeId: "modern-compact",
      placement: { x: 20, y: 30, scale: 2 },
      player: { name: "Live-Charakter", title: null, level: 31, resource: { name: "Fokus", color: "#FF8040" } },
      pet: { name: "Wegbegleiter", subtitle: "Spürhund", hpPercent: 80 },
    });

    await user.click(screen.getByText("Rückgängig").closest("summary") as HTMLElement);
    await user.click(screen.getByRole("button", { name: /Rev. 1/ }));
    expect(undo).toHaveBeenCalledWith(2, 1);
    expect(screen.getByRole("button", { name: "Abmelden" })).toBeEnabled();
    expect(logout).not.toHaveBeenCalled();
  });

  it("looks up a login only on explicit submit and adds the resolved identity", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    let resolveLookup: ((value: {
      id: string;
      login: string;
      displayName: string;
      profileImageUrl: string;
    }) => void) | undefined;
    const lookupTwitchUser = vi.fn<NonNullable<AdminApi["lookupTwitchUser"]>>(
      () => new Promise((resolve) => {
        resolveLookup = resolve;
      }),
    );
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
      lookupTwitchUser,
    }} />);

    const input = screen.getByLabelText("Twitch-Login oder Name");
    expect(screen.getByRole("button", { name: "Als Gast hinzufügen" })).toBeDisabled();
    await user.type(input, "Gast_TV");
    expect(lookupTwitchUser).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Auf Twitch suchen" })).toBeEnabled();

    await user.keyboard("{Enter}");
    expect(lookupTwitchUser).toHaveBeenCalledTimes(1);
    expect(lookupTwitchUser).toHaveBeenCalledWith("gast_tv");
    expect(screen.getByRole("button", { name: "Wird gesucht …" })).toBeDisabled();

    act(() => {
      resolveLookup?.({
        id: "99999999999999999999",
        login: "gast_tv",
        displayName: "Kanonischer Gast",
        profileImageUrl: "https://example.test/gast.png",
      });
    });
    expect(await screen.findByText("Kanonischer Gast")).toBeInTheDocument();
    expect(screen.getByText("@gast_tv")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hinzufügen" }));
    expect(screen.getByRole("slider", { name: "Kanonischer Gast Gesundheit" })).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Gast_TV Gesundheit" })).not.toBeInTheDocument();
  });

  it("adds names outside the login format manually without a lookup", async () => {
    const user = userEvent.setup();
    const lookupTwitchUser = vi.fn<NonNullable<AdminApi["lookupTwitchUser"]>>();
    render(<AdminWorkspace initialBootstrap={bootstrap()} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
      lookupTwitchUser,
    }} />);

    const input = screen.getByLabelText("Twitch-Login oder Name");
    await user.type(input, "Der Kumpel");
    await user.click(screen.getByRole("button", { name: "Als Gast hinzufügen" }));

    expect(lookupTwitchUser).not.toHaveBeenCalled();
    expect(screen.getByRole("slider", { name: "Der Kumpel Gesundheit" })).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("does not submit a whitespace-only guest name", async () => {
    const user = userEvent.setup();
    const lookupTwitchUser = vi.fn<NonNullable<AdminApi["lookupTwitchUser"]>>();
    render(<AdminWorkspace initialBootstrap={bootstrap()} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
      lookupTwitchUser,
    }} />);

    const input = screen.getByLabelText("Twitch-Login oder Name");
    await user.type(input, "   ");
    expect(screen.getByRole("button", { name: "Als Gast hinzufügen" })).toBeDisabled();
    await user.keyboard("{Enter}");

    expect(lookupTwitchUser).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".guest-control")).toHaveLength(0);
  });

  it("marks a resolved Twitch guest that is already in the group and cannot add it again", async () => {
    const user = userEvent.setup();
    const initial = bootstrap();
    initial.state.group = [{
      id: "existing-twitch-guest",
      source: "twitch",
      twitchUserId: twitchUserIdSchema.parse("99999999999999999999"),
      name: "Bereits da",
      portrait: {
        kind: "twitch",
        userId: twitchUserIdSchema.parse("99999999999999999999"),
        url: "https://example.test/existing.png",
      },
      hpPercent: 100,
    }];
    const lookupTwitchUser = vi.fn<NonNullable<AdminApi["lookupTwitchUser"]>>(() => Promise.resolve({
      id: "99999999999999999999",
      login: "gast_tv",
      displayName: "GastTV",
      profileImageUrl: "https://example.test/gast.png",
    }));
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
      lookupTwitchUser,
    }} />);

    await user.type(screen.getByLabelText("Twitch-Login oder Name"), "gast_tv");
    await user.click(screen.getByRole("button", { name: "Auf Twitch suchen" }));
    expect(await screen.findByText("bereits in der Gruppe")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hinzufügen" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Bereits da Gesundheit" })).toBeInTheDocument();
  });

  it("offers manual addition for a Twitch lookup that returns not found", async () => {
    const user = userEvent.setup();
    const notFound = Object.assign(new Error("not found"), { code: "not_found", status: 404 });
    const lookupTwitchUser = vi.fn<NonNullable<AdminApi["lookupTwitchUser"]>>(() => Promise.reject(notFound));
    render(<AdminWorkspace initialBootstrap={bootstrap()} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
      lookupTwitchUser,
    }} />);

    const input = screen.getByLabelText("Twitch-Login oder Name");
    await user.type(input, "unbekannt");
    await user.click(screen.getByRole("button", { name: "Auf Twitch suchen" }));
    expect(await screen.findByText("Kein Twitch-Konto mit diesem Login")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /unbekannt.*als manuellen Gast hinzufügen/ }));
    expect(screen.getByRole("slider", { name: "unbekannt Gesundheit" })).toBeInTheDocument();
  });

  it("keeps Twitch lookup errors local and leaves the manual fallback usable", async () => {
    const user = userEvent.setup();
    const lookupTwitchUser = vi.fn<NonNullable<AdminApi["lookupTwitchUser"]>>(() => Promise.reject(new Error("network down")));
    render(<AdminWorkspace initialBootstrap={bootstrap()} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
      lookupTwitchUser,
    }} />);

    const input = screen.getByLabelText("Twitch-Login oder Name");
    await user.type(input, "gast_tv");
    await user.click(screen.getByRole("button", { name: "Auf Twitch suchen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Twitch-Gast konnte nicht geladen werden.");
    expect(screen.getByText("Alles veröffentlicht")).toBeInTheDocument();
    expect(screen.queryByText("network down")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /gast_tv.*als manuellen Gast hinzufügen/ }));
    expect(screen.getByRole("slider", { name: "gast_tv Gesundheit" })).toBeInTheDocument();
  });

  it("can still add a manual guest whose name happens to look like a Twitch login", async () => {
    const user = userEvent.setup();
    const lookupTwitchUser = vi.fn<NonNullable<AdminApi["lookupTwitchUser"]>>(() => Promise.resolve({
      id: "99887766554433221100",
      login: "kevin",
      displayName: "Kevin",
      profileImageUrl: "https://static-cdn.jtvnw.net/kevin.png",
    }));
    render(<AdminWorkspace initialBootstrap={bootstrap()} api={{
      save: vi.fn(),
      setVisibility: vi.fn(),
      lookupTwitchUser,
    }} />);

    await user.type(screen.getByLabelText("Twitch-Login oder Name"), "kevin");
    await user.click(screen.getByRole("button", { name: "Auf Twitch suchen" }));
    expect(await screen.findByText("@kevin")).toBeInTheDocument();

    // Der Treffer ist der falsche Kevin: der manuelle Ausweg muss offen bleiben,
    // sonst gaebe es fuer login-foermige Namen ueberhaupt keinen manuellen Gast.
    await user.click(screen.getByRole("button", { name: /kevin.*als manuellen Gast hinzufügen/ }));
    expect(screen.getByRole("slider", { name: "kevin Gesundheit" })).toBeInTheDocument();
    expect(screen.queryByText("@kevin")).not.toBeInTheDocument();
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
    expect(screen.getByText(/Speichern pausiert/)).toBeInTheDocument();
    // Kein modul-eigener Button mehr, und ohnehin nichts dirty: die globale
    // Speicherleiste existiert noch gar nicht.
    expect(screen.queryByRole("button", { name: "Alle speichern" })).not.toBeInTheDocument();
    act(() => onOnlineChange?.(true));
    fireEvent.change(screen.getByRole("slider", { name: "Gesundheit" }), { target: { value: "40" } });
    await user.click(screen.getByRole("button", { name: "Alle speichern" }));
    expect(await screen.findByText("Save fehlgeschlagen")).toBeInTheDocument();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("switch", { name: "Overlay aktiv" }));
    expect(await screen.findByText("Sichtbarkeit fehlgeschlagen")).toBeInTheDocument();
  });

  it("ticks the live preview clock every second so an effect countdown advances on its own", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00.000Z"));
    const initial = bootstrap();
    initial.state.effects = [{
      id: "effect-1",
      catalogId: "buff-gestaerkt",
      kind: "buff",
      name: "Gestärkt",
      description: null,
      iconId: "buff-gestaerkt",
      stacks: null,
      expiresAt: "2026-08-29T12:02:05.000Z",
      order: 0,
    }];
    render(<AdminWorkspace initialBootstrap={initial} api={{
      save: vi.fn(),
      setVisibility: () => Promise.resolve({ state: initial.state, auditEntry: null, undoTargets: [], serverTime: initial.serverTime }),
    }} />);

    expect(screen.getByText("2:05")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByText("2:05")).not.toBeInTheDocument();
    expect(screen.getByText("2:04")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByText("2:01")).toBeInTheDocument();
  });

  it("renews only the currently pending upload leases once per interval, unaffected by intervening draft edits", async () => {
    vi.useFakeTimers();
    const initial = bootstrap();
    const contentHash = "c".repeat(64);
    const uploadPortrait = vi.fn<NonNullable<AdminApi["uploadPortrait"]>>(() =>
      Promise.resolve({ kind: "uploaded", contentHash }),
    );
    const renewMediaLeases = vi.fn<NonNullable<AdminApi["renewMediaLeases"]>>(() => Promise.resolve());
    const bitmap = { width: 4, height: 4, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob(["portrait"], { type: "image/webp" }));
    });

    render(<AdminWorkspace initialBootstrap={initial} api={{
      save: vi.fn(),
      setVisibility: () => Promise.resolve({ state: initial.state, auditEntry: null, undoTargets: [], serverTime: initial.serverTime }),
      uploadPortrait,
      renewMediaLeases,
    }} />);

    fireEvent.click(screen.getByText("Einrichten").closest("summary") as HTMLElement);
    const file = new File(["portrait-bytes"], "portrait.png", { type: "image/png" });
    const fileInput = screen.getByLabelText("Portrait hochladen");
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
      for (let index = 0; index < 6; index += 1) {
        await Promise.resolve();
      }
    });
    expect(uploadPortrait).toHaveBeenCalledTimes(1);

    // Der Draft wird mehrfach geändert - das Renew-Intervall darf dadurch NICHT neu starten.
    fireEvent.change(screen.getByRole("slider", { name: "Gesundheit" }), { target: { value: "10" } });
    fireEvent.change(screen.getByRole("slider", { name: "Gesundheit" }), { target: { value: "20" } });
    fireEvent.change(screen.getByRole("slider", { name: "Gesundheit" }), { target: { value: "30" } });

    expect(renewMediaLeases).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
    });

    expect(renewMediaLeases).toHaveBeenCalledTimes(1);
    expect(renewMediaLeases).toHaveBeenCalledWith([contentHash]);
  });
});
