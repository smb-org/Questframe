import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChallengeBoard,
  type ChallengeBoardApi,
  type ChallengeBoardSaveHandle,
} from "../../../src/modules/win-challenges/ui/ChallengeBoard";
import type {
  BoardSaveResponse,
  ChallengeBoardSnapshot,
  ChallengeSetV1,
} from "../../../src/modules/win-challenges/contracts/schemas";
import type { ChallengeUpdate } from "../../../src/shared/contracts/win-challenges";

const instant = "2026-08-31T10:00:00.000Z";

const challenge = (
  id: string,
  title: string,
  overrides: Partial<ChallengeBoardSnapshot["challenges"][number]> = {},
): ChallengeBoardSnapshot["challenges"][number] => ({
  id,
  title,
  kind: "counter",
  unit: null,
  controlKey: "K7RP",
  targetCount: 10,
  timerTotalMs: null,
  sortOrder: 0,
  step: 1,
  bestCount: 0,
  hidden: false,
  currentCount: 0,
  state: "pending",
  timerEndsAt: null,
  timerRemainMs: null,
  completedAt: null,
  createdAt: instant,
  updatedAt: instant,
  ...overrides,
});

const snapshot = (
  challenges: ChallengeBoardSnapshot["challenges"],
  boardRevision = 1,
): ChallengeBoardSnapshot => ({
  eventSeq: 0,
  boardRevision,
  settingsRevision: 1,
  settings: {
    styleId: "plain-list",
    themeMode: "inherit",
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
    overflowMode: "cut", overflowTempo: "medium", numbered: false, keyVisible: false, doneOrder: "end", globalTimerMode: "down",
    globalTimer: null,
    placement: { x: 300, y: 8, scale: 1 },
  },
  challenges,
});

const responseFor = (next: ChallengeBoardSnapshot, createdIds: Record<string, string> = {}): BoardSaveResponse => ({
  snapshot: next,
  createdIds,
});

const setFileChallenge: ChallengeSetV1["challenges"][number] = {
  title: "Importierte Challenge",
  kind: "counter",
  unit: null,
  targetCount: 5,
  timerTotalMs: null,
  sortOrder: 0,
  step: 1,
  hidden: false,
};

const setFilePayload = (overrides: Partial<ChallengeSetV1> = {}): ChallengeSetV1 => ({
  schemaVersion: 1,
  name: "Elden Ring Bingo",
  createdAt: instant,
  challenges: [setFileChallenge],
  ...overrides,
});

const setFile = (overrides: Partial<ChallengeSetV1> = {}, name = "elden-ring.json"): File => new File([
  JSON.stringify(setFilePayload(overrides)),
], name, { type: "application/json" });

// Kein modul-eigener Speichern-Button mehr (die globale Speicherleiste ruft save() ueber
// diesen Griff auf) – Tests loesen das Speichern daher genauso aus: ueber den per
// onHandleChange registrierten Handle statt einen Button anzuklicken.
const renderBoard = (initial: ChallengeBoardSnapshot, save = vi.fn<ChallengeBoardApi["save"]>()) => {
  const api: ChallengeBoardApi = {
    load: vi.fn(() => Promise.resolve(initial)),
    save,
  };
  let handle: ChallengeBoardSaveHandle | null = null;
  render(<ChallengeBoard api={api} onHandleChange={(next) => { handle = next; }} />);
  const triggerSave = () => act(async () => {
    if (handle === null) throw new Error("Speicher-Griff noch nicht registriert.");
    await handle.save();
  });
  return { api, save, triggerSave };
};

const firstRow = (): HTMLElement => {
  const row = document.querySelector(".challenge-board-row");
  if (!(row instanceof HTMLElement)) throw new Error("Challenge-Zeile fehlt.");
  return row;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChallengeBoard", () => {
  it("zeigt im leeren Board die Set-Aktion deaktiviert mit einem Grund", async () => {
    renderBoard(snapshot([]));

    expect(await screen.findByText("Noch kein Set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aktuelles Board als Set sichern" })).toBeDisabled();
    expect(screen.getByText("Export nicht verfügbar: Das Board ist leer.")).toBeInTheDocument();
  });

  it("füllt der Import nur den lokalen Entwurf und markiert den nächsten Save als Set-Wechsel", async () => {
    const initial = snapshot([challenge("one", "Alte Challenge")]);
    const imported = snapshot([challenge("imported", "Importierte Challenge", { targetCount: 5 })], 2);
    const save = vi.fn<ChallengeBoardApi["save"]>().mockResolvedValue(responseFor(imported, { "client-import": "imported" }));
    const { triggerSave, save: saveSpy } = renderBoard(initial, save);
    const fileInput = await screen.findByLabelText("Set-Datei auswählen");

    fireEvent.change(fileInput, { target: { files: [setFile()] } });

    expect(await screen.findByDisplayValue("Importierte Challenge")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Alte Challenge")).not.toBeInTheDocument();
    expect(saveSpy).not.toHaveBeenCalled();

    await triggerSave();
    expect(saveSpy.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ reason: "set-switch" }));
  });

  it("fragt vor einem Import in einen ungespeicherten Entwurf und lässt ihn bei Ablehnung unverändert", async () => {
    const user = userEvent.setup();
    const initial = snapshot([challenge("one", "Lokaler Entwurf")]);
    renderBoard(initial);
    const title = await screen.findByDisplayValue("Lokaler Entwurf");
    await user.clear(title);
    await user.type(title, "Meine Änderung");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fileInput = screen.getByLabelText("Set-Datei auswählen");

    fireEvent.change(fileInput, { target: { files: [setFile()] } });

    const dialog = await screen.findByRole("dialog", { name: "Ungespeicherte Änderungen" });
    expect(dialog).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(screen.getByDisplayValue("Meine Änderung")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Importierte Challenge")).not.toBeInTheDocument();
  });

  it.each([
    ["zu große Dateien", new File(["x".repeat(65 * 1024 + 1)], "zu-gross.json"), "Set-Datei: zu-gross.json ist zu groß (maximal 64 KiB)."],
    ["kaputtes JSON", new File(["{ kaputt"], "kaputt.json"), "Set-Datei: JSON ist ungültig."],
    ["fremde Version", new File([JSON.stringify({ ...setFilePayload(), schemaVersion: 2 })], "version.json"), "Set-Datei schemaVersion: Version 2 wird nicht unterstützt; erwartet wird Version 1."],
    ["zu viele Aufgaben", setFile({ challenges: Array.from({ length: 31 }, (_, index) => ({ ...setFileChallenge, title: `Challenge ${String(index)}` })) }), "Set-Datei challenges: 31 Aufgaben erkannt; maximal 30 sind erlaubt."],
  ])("verändert den Draft nicht bei %s", async (_caseName, invalidFile, message) => {
    const initial = snapshot([challenge("one", "Bleibt erhalten")]);
    renderBoard(initial);
    await screen.findByDisplayValue("Bleibt erhalten");
    fireEvent.change(screen.getByLabelText("Set-Datei auswählen"), { target: { files: [invalidFile] } });

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByDisplayValue("Bleibt erhalten")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Importierte Challenge")).not.toBeInTheDocument();
  });

  it("zeigt den importierten Set-Namen und den geänderten Zustand, bis der Save erfolgreich war", async () => {
    const user = userEvent.setup();
    const initial = snapshot([challenge("one", "Alte Challenge")]);
    const imported = snapshot([challenge("imported", "Importierte Challenge", { targetCount: 5 })], 2);
    const save = vi.fn<ChallengeBoardApi["save"]>().mockResolvedValue(responseFor(imported, { "client-import": "imported" }));
    const { triggerSave } = renderBoard(initial, save);
    const fileInput = await screen.findByLabelText("Set-Datei auswählen");

    fireEvent.change(fileInput, { target: { files: [setFile()] } });
    await screen.findByDisplayValue("Importierte Challenge");
    expect(screen.getByText("Elden Ring Bingo · geändert")).toBeInTheDocument();
    await user.clear(screen.getByDisplayValue("Importierte Challenge"));
    await user.type(screen.getByLabelText("Challenge"), "Noch angepasst");
    expect(screen.getByText("Elden Ring Bingo · geändert")).toBeInTheDocument();

    await triggerSave();

    await waitFor(() => expect(screen.getByText("Elden Ring Bingo")).toBeInTheDocument());
    expect(screen.queryByText("Elden Ring Bingo · geändert")).not.toBeInTheDocument();
    expect(screen.getByText("Elden Ring Bingo")).toHaveClass("challenge-set-name--published");
    expect(screen.getByText("Entwurf veröffentlicht.")).toBeInTheDocument();

    await user.clear(screen.getByDisplayValue("Importierte Challenge"));
    await user.type(screen.getByLabelText("Challenge"), "Dritte Anpassung");
    expect(screen.queryByText("Entwurf veröffentlicht.")).not.toBeInTheDocument();
  });

  it("vergisst ein Set bei einem externen Update eines sauberen Boards", async () => {
    const callbacks: { onChallengeUpdate?: (update: ChallengeUpdate) => void } = {};
    const initial = snapshot([challenge("one", "Alte Challenge")]);
    const imported = snapshot([challenge("imported", "Importierte Challenge", { targetCount: 5 })], 2);
    const save = vi.fn<ChallengeBoardApi["save"]>().mockResolvedValue(responseFor(imported, { "client-import": "imported" }));
    const api: ChallengeBoardApi = {
      load: vi.fn(() => Promise.resolve(initial)),
      save,
      subscribe: (subscription) => {
        callbacks.onChallengeUpdate = subscription.onChallengeUpdate;
        return () => undefined;
      },
    };
    let handle: ChallengeBoardSaveHandle | null = null;
    render(<ChallengeBoard api={api} onHandleChange={(next) => { handle = next; }} />);

    fireEvent.change(await screen.findByLabelText("Set-Datei auswählen"), { target: { files: [setFile()] } });
    await screen.findByDisplayValue("Importierte Challenge");
    await act(async () => { await handle?.save(); });
    expect(screen.getByText("Elden Ring Bingo")).toBeInTheDocument();

    const external = snapshot([challenge("other", "Andere Challenge")], 3);
    const emitExternalUpdate = callbacks.onChallengeUpdate;
    if (emitExternalUpdate === undefined) throw new Error("Subscription wurde nicht registriert.");
    act(() => emitExternalUpdate({ ...external, settings: { ...external.settings, themeId: "trail-wood" }, event: null }));

    await waitFor(() => expect(screen.queryByText("Elden Ring Bingo")).not.toBeInTheDocument());
    expect(screen.getByDisplayValue("Andere Challenge")).toBeInTheDocument();
  });

  it("lässt lokale Set-Dateiaktionen offline verfügbar", async () => {
    render(<ChallengeBoard api={{ load: vi.fn(() => Promise.resolve(snapshot([challenge("one", "Bellen")]))), save: vi.fn() }} online={false} />);

    expect(await screen.findByRole("button", { name: "Set importieren" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Set exportieren" })).toBeEnabled();
  });

  it("exportiert den aktuellen Board-Entwurf ohne Fortschritt", async () => {
    const user = userEvent.setup();
    const initial = snapshot([challenge("one", "Bellen", { currentCount: 4, bestCount: 8, state: "active" })]);
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderBoard(initial);

    await user.click(await screen.findByRole("button", { name: "Set exportieren" }));

    const anchor = click.mock.instances[0];
    expect((anchor as HTMLAnchorElement | undefined)?.download).toMatch(/^Challenge-Board-\d{4}-\d{2}-\d{2}\.json$/);
    expect(createObjectUrl).toHaveBeenCalledOnce();
    const blob = createObjectUrl.mock.calls[0]?.[0];
    if (!(blob instanceof Blob)) throw new Error("Export muss einen Blob erzeugen.");
    expect(await blob.text()).not.toContain("currentCount");
    expect(await blob.text()).not.toContain("bestCount");
  });

  it("sendet bei einem gewöhnlichen Save nach dem Set-Save keinen Set-Wechsel-Grund", async () => {
    const user = userEvent.setup();
    const initial = snapshot([challenge("one", "Bellen")]);
    const firstResponse = snapshot([challenge("one", "Erster Save")], 2);
    const secondResponse = snapshot([challenge("one", "Zweiter Save")], 3);
    const save = vi.fn<ChallengeBoardApi["save"]>()
      .mockResolvedValueOnce(responseFor(firstResponse))
      .mockResolvedValueOnce(responseFor(secondResponse));
    const { triggerSave } = renderBoard(initial, save);
    const fileInput = await screen.findByLabelText("Set-Datei auswählen");

    fireEvent.change(fileInput, { target: { files: [setFile()] } });
    await screen.findByDisplayValue("Importierte Challenge");
    await triggerSave();
    await user.clear(screen.getByDisplayValue("Erster Save"));
    await user.type(screen.getByLabelText("Challenge"), "Zweiter Save");
    await triggerSave();

    expect(save.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ reason: "set-switch" }));
    expect(save.mock.calls[1]?.[0]).not.toHaveProperty("reason");
  });

  it("zeigt nur den Overlay-Text und gruppiert Laufzeitaktionen sowie Ziel und Timer kompakt", async () => {
    const initial = snapshot([challenge("one", "Bellen")]);
    renderBoard(initial);

    const challengeInput = await screen.findByRole("textbox", { name: "Challenge" });
    const row = challengeInput.closest("article");
    if (!(row instanceof HTMLElement)) throw new Error("Challenge-Zeile fehlt.");

    expect(within(row).getAllByRole("textbox")).toEqual([challengeInput]);
    expect(within(row).queryByRole("textbox", { name: "Beschreibung" })).not.toBeInTheDocument();
    expect(within(row).getByRole("group", { name: "Ziel und Timer" })).toBeInTheDocument();

    const visibility = within(row).getByRole("switch", { name: "Bellen ausblenden" });
    const remove = within(row).getByRole("button", { name: "Bellen löschen" });
    expect(visibility.compareDocumentPosition(challengeInput) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(remove.compareDocumentPosition(challengeInput) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("zeigt stabile Nummern aus dem veröffentlichten Entwurf und überspringt versteckte Einträge", async () => {
    const initial = snapshot([
      challenge("hidden", "Versteckt", { hidden: true, sortOrder: 0 }),
      challenge("first", "Erste", { sortOrder: 1 }),
      challenge("second", "Zweite", { sortOrder: 2 }),
    ]);
    const update = {
      ...initial,
      settings: { ...initial.settings, themeId: "trail-wood" as const, numbered: true },
      event: null,
    };
    render(<ChallengeBoard api={{ load: vi.fn(() => Promise.resolve(initial)), save: vi.fn() }} challengeUpdate={update} />);

    const list = await screen.findByLabelText("Challenge-Definitionen");
    expect(within(list).getByText("1")).toBeInTheDocument();
    expect(within(list).getByText("2")).toBeInTheDocument();
    expect(within(list).queryByText("3")).not.toBeInTheDocument();
  });

  it("öffnet die kompakte Vollbildansicht und gibt den Fokus beim Schließen zurück", async () => {
    const user = userEvent.setup();
    const initial = snapshot([challenge("one", "Bellen")]);
    renderBoard(initial);

    const trigger = await screen.findByRole("button", { name: "Board im Vollbild bearbeiten" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("open", "");
    const compactTitle = within(dialog).getByDisplayValue("Bellen");
    expect(compactTitle).toHaveAttribute("type", "text");
    expect(within(dialog).queryByRole("group", { name: "Ziel und Timer" })).not.toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(trigger).toHaveFocus();
  });

  it("sendet nur den sichtbaren Challenge-Text", async () => {
    const user = userEvent.setup();
    const initial = snapshot([challenge("one", "Bellen")]);
    const save = vi.fn<ChallengeBoardApi["save"]>().mockResolvedValue(responseFor(initial));
    const { triggerSave } = renderBoard(initial, save);

    const challengeInput = await screen.findByRole("textbox", { name: "Challenge" });
    await user.clear(challengeInput);
    await user.type(challengeInput, "Fünfmal bellen");
    await triggerSave();

    expect(save.mock.calls[0]?.[0].challenges[0]).toMatchObject({
      title: "Fünfmal bellen",
    });
    expect(save.mock.calls[0]?.[0].challenges[0]).not.toHaveProperty("description");
  });

  it("erhaelt kind, unit und step bei einer unbeteiligten Aenderung", async () => {
    const user = userEvent.setup();
    const initial = snapshot([
      challenge("streak", "Serie", { kind: "streak", unit: null, step: 1, sortOrder: 0 }),
      challenge("measure", "Messwert", { kind: "measure", unit: "kg", step: 5, sortOrder: 1 }),
    ]);
    const save = vi.fn<ChallengeBoardApi["save"]>().mockResolvedValue(responseFor(initial));
    const { triggerSave } = renderBoard(initial, save);

    const streakTitle = await screen.findByDisplayValue("Serie");
    await user.clear(streakTitle);
    await user.type(streakTitle, "Serie 2.0");
    await triggerSave();

    expect(save.mock.calls[0]?.[0].challenges).toEqual([
      expect.objectContaining({ id: "streak", kind: "streak", unit: null, step: 1 }),
      expect.objectContaining({ id: "measure", kind: "measure", unit: "kg", step: 5 }),
    ]);
  });

  it("wendet clientId zu id an und sendet danach nur die echte ID", async () => {
    const user = userEvent.setup();
    const initial = snapshot([]);
    const saved = challenge("server-id", "Neue Challenge");
    const save = vi.fn<ChallengeBoardApi["save"]>()
      .mockResolvedValueOnce(responseFor(snapshot([saved], 2), { "client-id": "server-id" }))
      .mockResolvedValueOnce(responseFor(snapshot([challenge("server-id", "Umbenannt")], 3)));
    const { triggerSave } = renderBoard(initial, save);

    await user.click(await screen.findByRole("button", { name: "Challenge anlegen" }));
    const row = firstRow();
    const title = within(row).getByLabelText("Challenge");
    await user.clear(title);
    await user.type(title, "Neue Challenge");
    await triggerSave();

    const firstRequest = save.mock.calls[0]?.[0];
    if (firstRequest === undefined) throw new Error("Save-Request fehlt.");
    const firstDefinition = firstRequest.challenges[0];
    if (firstDefinition === undefined) throw new Error("Neue Definition fehlt.");
    expect("clientId" in firstDefinition).toBe(true);
    if ("clientId" in firstDefinition) expect(typeof firstDefinition.clientId).toBe("string");
    expect(firstDefinition).not.toHaveProperty("id");
    expect(screen.getByDisplayValue("Neue Challenge")).toBeInTheDocument();

    await user.clear(screen.getByDisplayValue("Neue Challenge"));
    await user.type(screen.getByLabelText("Challenge"), "Umbenannt");
    await triggerSave();
    expect(save.mock.calls[1]?.[0].challenges[0]).toMatchObject({ id: "server-id" });
    expect(save.mock.calls[1]?.[0].challenges[0]).not.toHaveProperty("clientId");
  });

  it("schaltet einzelne Challenges optimistisch aus und sperrt den Schalter für erledigte", async () => {
    const user = userEvent.setup();
    const initial = snapshot([
      challenge("open", "Offene Challenge"),
      challenge("done", "Erledigte Challenge", { state: "done", completedAt: instant }),
    ]);
    const save = vi.fn<ChallengeBoardApi["save"]>().mockResolvedValue(responseFor(initial));
    renderBoard(initial, save);

    const openRow = await screen.findByDisplayValue("Offene Challenge").then((input) => input.closest("article"));
    if (!(openRow instanceof HTMLElement)) throw new Error("Offene Challenge-Zeile fehlt.");
    const openToggle = within(openRow).getByRole("switch", { name: "Offene Challenge ausblenden" });
    expect(openToggle).toHaveAttribute("aria-checked", "true");
    expect(openToggle).toHaveClass("is-on");
    await user.click(openToggle);
    expect(openToggle).toHaveAttribute("aria-checked", "false");
    expect(openToggle).toHaveClass("is-off");

    const doneRow = screen.getByDisplayValue("Erledigte Challenge").closest("article");
    if (!(doneRow instanceof HTMLElement)) throw new Error("Erledigte Challenge-Zeile fehlt.");
    const doneToggle = within(doneRow).getByRole("switch", { name: "Erledigte Challenge ausblenden" });
    expect(doneToggle).toBeDisabled();
    expect(doneToggle).toHaveAttribute("title", "Erledigte Challenges können nicht ausgeblendet werden.");
    expect(within(doneRow).getByText("Erledigte Challenges bleiben sichtbar.")).toBeInTheDocument();
  });

  it("löscht durch Weglassen und übernimmt die serverseitig renormalisierte Reihenfolge", async () => {
    const user = userEvent.setup();
    const initial = snapshot([
      challenge("first", "Erste", { sortOrder: 0 }),
      challenge("second", "Zweite", { sortOrder: 1 }),
    ]);
    const serverSnapshot = snapshot([challenge("second", "Zweite", { sortOrder: 0 })], 2);
    const save = vi.fn<ChallengeBoardApi["save"]>().mockResolvedValue(responseFor(serverSnapshot));
    const { triggerSave } = renderBoard(initial, save);

    await screen.findByDisplayValue("Erste");
    await user.click(screen.getByRole("button", { name: "Erste löschen" }));
    await triggerSave();

    expect(save.mock.calls[0]?.[0].challenges).toEqual([expect.objectContaining({ id: "second", sortOrder: 0 })]);
    expect(screen.getByDisplayValue("Zweite")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Erste")).not.toBeInTheDocument();
    expect(screen.getByText("Board gespeichert · Revision 2.")).toBeInTheDocument();
  });

  it("zeigt alle vier Folgen der Merge-Regeln vor dem Speichern", async () => {
    const user = userEvent.setup();
    const initial = snapshot([challenge("active", "Laufende Challenge", {
      targetCount: 10,
      timerTotalMs: 60_000,
      currentCount: 5,
      state: "active",
      timerEndsAt: "2026-08-31T10:01:00.000Z",
    })]);
    renderBoard(initial);
    await screen.findByDisplayValue("Laufende Challenge");
    const row = firstRow();
    const targetToggle = within(row).getByRole("checkbox", { name: "Laufende Challenge mit Zielwert" });
    const timerToggle = within(row).getByRole("checkbox", { name: "Laufende Challenge mit Timer" });
    const targetInput = within(row).getByRole("spinbutton", { name: "Laufende Challenge Zielwert" });
    const timerInput = within(row).getByRole("spinbutton", { name: "Laufende Challenge Timerdauer in Sekunden" });

    await user.click(targetToggle);
    expect(screen.getByText(/Gespeicherter Stand bleibt erhalten: 5/)).toBeInTheDocument();
    expect(within(row).getByText("Stand bleibt erhalten")).toBeInTheDocument();

    await user.click(targetToggle);
    fireEvent.change(targetInput, { target: { value: "3" } });
    expect(screen.getByText(/Stand auf 3 geklemmt/)).toBeInTheDocument();

    await user.click(timerToggle);
    expect(screen.getByText(/laufende Timer endet beim Speichern/)).toBeInTheDocument();

    await user.click(timerToggle);
    fireEvent.change(timerInput, { target: { value: "120" } });
    expect(screen.getByText(/behält seinen Endzeitpunkt/)).toBeInTheDocument();
  });

  it("kündigt bei einem übererfüllten measure keinen Clamp beim Speichern an", async () => {
    const initial = snapshot([challenge("measure", "Meter", {
      kind: "measure",
      unit: "m",
      targetCount: 1_500,
      currentCount: 1_800,
      step: 50,
    })]);
    renderBoard(initial);

    await screen.findByDisplayValue("Meter");
    expect(screen.queryByText(/geklemmt/)).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Meter Zielwert" })).toHaveAttribute("max", "1000000");
  });

  it("zeigt einen revision_conflict mit Serverstand und überschreibt ihn nicht still", async () => {
    const user = userEvent.setup();
    const initial = snapshot([challenge("one", "Lokaler Entwurf")]);
    const foreign = snapshot([challenge("one", "Fremde Änderung"), challenge("two", "Neu von außen", { sortOrder: 1 })], 2);
    const save = vi.fn<ChallengeBoardApi["save"]>().mockRejectedValue({
      code: "revision_conflict",
      currentSnapshot: foreign,
    });
    const { triggerSave } = renderBoard(initial, save);

    const title = await screen.findByDisplayValue("Lokaler Entwurf");
    await user.clear(title);
    await user.type(title, "Mein Entwurf");
    await triggerSave();

    expect(await screen.findByText("Jemand anderes hat das Board gespeichert.")).toBeInTheDocument();
    expect(screen.getByText("Fremde Änderung")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Mein Entwurf")).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
    // Kein modul-eigener Button mehr: der interne Konflikt-Schutz in save() selbst
    // muss ein blindes Ueberschreiben weiter verhindern (die Leiste wuerde denselben
    // save() erneut aufrufen, ohne replaceForeignBoard).
    await triggerSave();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("übernimmt Challenge-Updates über den bestehenden Editor-Socket ohne lokalen Entwurf zu verlieren", async () => {
    const user = userEvent.setup();
    let onUpdate: ((update: ChallengeUpdate) => void) | undefined;
    const initial = snapshot([challenge("one", "Vorher")]);
    const incoming = snapshot([challenge("one", "Von außen")], 2);
    const api: ChallengeBoardApi = {
      load: vi.fn(() => Promise.resolve(initial)),
      save: vi.fn(),
      subscribe: (callbacks) => {
        onUpdate = callbacks.onChallengeUpdate;
        return () => undefined;
      },
    };
    render(<ChallengeBoard api={api} />);
    const title = await screen.findByDisplayValue("Vorher");
    await user.clear(title);
    await user.type(title, "Mein Entwurf");
    onUpdate?.({
      ...incoming,
      settings: { ...incoming.settings, themeId: "trail-wood" },
      event: null,
    });

    expect(await screen.findByText("Jemand anderes hat das Board gespeichert.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Mein Entwurf")).toBeInTheDocument();
    expect(screen.getByText("Von außen")).toBeInTheDocument();
  });

  it("behandelt das eigene Socket-Echo während des Speicherns nicht als Konflikt und übernimmt erstellte IDs", async () => {
    const user = userEvent.setup();
    let onUpdate: ((update: ChallengeUpdate) => void) | undefined;
    let resolveSave: ((value: BoardSaveResponse) => void) | undefined;
    const initial = snapshot([], 1);
    const save = vi.fn<ChallengeBoardApi["save"]>(() => new Promise<BoardSaveResponse>((resolve) => { resolveSave = resolve; }));
    const api: ChallengeBoardApi = {
      load: vi.fn(() => Promise.resolve(initial)),
      save,
      subscribe: (callbacks) => { onUpdate = callbacks.onChallengeUpdate; return () => undefined; },
    };
    let handle: ChallengeBoardSaveHandle | null = null;
    render(<ChallengeBoard api={api} onHandleChange={(next) => { handle = next; }} />);

    await user.click(await screen.findByRole("button", { name: "Challenge anlegen" }));
    const title = screen.getByDisplayValue("Neue Challenge");
    act(() => {
      if (handle === null) throw new Error("Speicher-Griff noch nicht registriert.");
      void handle.save();
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    const firstDefinition = save.mock.calls[0]?.[0].challenges[0];
    if (firstDefinition === undefined || !("clientId" in firstDefinition)) throw new Error("Neue Definition fehlt.");
    const echoed = challenge("server-id", "Neue Challenge", { targetCount: null });
    const incoming = snapshot([echoed], 2);
    act(() => {
      onUpdate?.({ ...incoming, settings: { ...incoming.settings, themeId: "trail-wood" }, event: null });
    });

    expect(screen.queryByText("Jemand anderes hat das Board gespeichert.")).not.toBeInTheDocument();
    resolveSave?.(responseFor(incoming, { [firstDefinition.clientId]: "server-id" }));
    await waitFor(() => expect(screen.getByDisplayValue("Neue Challenge")).toBeInTheDocument());
    expect(screen.queryByText("Jemand anderes hat das Board gespeichert.")).not.toBeInTheDocument();

    const next = snapshot([challenge("server-id", "Nach Echo", { targetCount: null })], 3);
    save.mockResolvedValueOnce(responseFor(next));
    await user.clear(title);
    await user.type(title, "Nach Echo");
    await act(async () => {
      if (handle === null) throw new Error("Speicher-Griff fehlt nach der Reconciliation.");
      await handle.save();
    });

    expect(save.mock.calls[1]?.[0].challenges[0]).toMatchObject({ id: "server-id" });
    expect(save.mock.calls[1]?.[0].challenges[0]).not.toHaveProperty("clientId");
  });

  it("verwirft eine verspätete Load-Antwort mit älterer Board-Revision als ein Socket-Update", async () => {
    let resolveLoad: ((value: ChallengeBoardSnapshot) => void) | undefined;
    let onUpdate: ((update: ChallengeUpdate) => void) | undefined;
    const initial = snapshot([challenge("one", "Aus Load")], 1);
    const incoming = snapshot([challenge("one", "Aus Socket")], 2);
    const api: ChallengeBoardApi = {
      load: vi.fn(() => new Promise<ChallengeBoardSnapshot>((resolve) => { resolveLoad = resolve; })),
      save: vi.fn(),
      subscribe: (callbacks) => {
        onUpdate = callbacks.onChallengeUpdate;
        return () => undefined;
      },
    };
    render(<ChallengeBoard api={api} />);

    await waitFor(() => expect(onUpdate).toBeDefined());
    onUpdate?.({ ...incoming, settings: { ...incoming.settings, themeId: "trail-wood" }, event: null });
    resolveLoad?.(initial);
    expect(await screen.findByDisplayValue("Aus Socket")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Aus Load")).not.toBeInTheDocument();
  });

  // Review-Befund: eine verspätete (aber erfolgreiche) Save-Antwort für eine ältere
  // Revision darf einen inzwischen per Socket eingetroffenen neueren Stand nicht
  // zurückdrehen – auch keinen dabei erkannten echten Konflikt stillschweigend löschen.
  it("verwirft eine verspätete Save-Antwort gegenüber einer inzwischen per Socket eingetroffenen neueren boardRevision", async () => {
    const user = userEvent.setup();
    let onUpdate: ((update: ChallengeUpdate) => void) | undefined;
    const initial = snapshot([challenge("one", "Lokaler Entwurf")], 1);
    let resolveSave: ((value: BoardSaveResponse) => void) | undefined;
    const save = vi.fn<ChallengeBoardApi["save"]>(() => new Promise<BoardSaveResponse>((resolve) => { resolveSave = resolve; }));
    const api: ChallengeBoardApi = {
      load: vi.fn(() => Promise.resolve(initial)),
      save,
      subscribe: (callbacks) => { onUpdate = callbacks.onChallengeUpdate; return () => undefined; },
    };
    let handle: ChallengeBoardSaveHandle | null = null;
    render(<ChallengeBoard api={api} onHandleChange={(next) => { handle = next; }} />);

    const title = await screen.findByDisplayValue("Lokaler Entwurf");
    await user.clear(title);
    await user.type(title, "Mein Entwurf");
    // Kein modul-eigener Button mehr: ueber den Handle ausloesen, wie es die globale
    // Speicherleiste tut. Nicht awaiten (die Antwort kommt erst spaeter per resolveSave).
    act(() => {
      if (handle === null) throw new Error("Speicher-Griff noch nicht registriert.");
      void handle.save();
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    // Während unsere eigene Antwort noch unterwegs ist, trifft per Socket eine neuere,
    // per se noch unversöhnte Revision ein (z.B. von einem zweiten Editor) – das Board
    // erkennt zurecht einen echten Konflikt, weil unser lokaler Entwurf davon abweicht.
    const incoming = snapshot([challenge("one", "Fremde Änderung")], 3);
    onUpdate?.({ ...incoming, settings: { ...incoming.settings, themeId: "trail-wood" }, event: null });
    expect(await screen.findByText("Jemand anderes hat das Board gespeichert.")).toBeInTheDocument();

    // Jetzt kommt die verspätete Antwort für unseren (jetzt veralteten) Request rein –
    // mit einer niedrigeren boardRevision als der bereits bekannte Socket-Stand.
    resolveSave?.(responseFor(snapshot([challenge("one", "Mein Entwurf")], 2)));
    await waitFor(() => expect(screen.getByText("Board gespeichert · Revision 2.")).toBeInTheDocument());

    // Der echte, neuere Konflikt (Revision 3) darf dadurch nicht verschwinden.
    expect(screen.getByText("Jemand anderes hat das Board gespeichert.")).toBeInTheDocument();
  });
});
