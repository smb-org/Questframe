import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChallengeBoard,
  type ChallengeBoardApi,
} from "../../../src/modules/win-challenges/ui/ChallengeBoard";
import type {
  BoardSaveResponse,
  ChallengeBoardSnapshot,
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
  description: null,
  targetCount: 10,
  timerTotalMs: null,
  sortOrder: 0,
  hidden: false,
  currentCount: 0,
  state: "pending",
  timerEndsAt: null,
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
    surfaceMode: "surface",
    headerTitle: "CHALLENGES",
    effectsEnabled: true,
    maxVisible: 5,
    globalTimer: null,
    placement: { x: 300, y: 8, scale: 1 },
  },
  challenges,
});

const responseFor = (next: ChallengeBoardSnapshot, createdIds: Record<string, string> = {}): BoardSaveResponse => ({
  snapshot: next,
  createdIds,
});

const renderBoard = (initial: ChallengeBoardSnapshot, save = vi.fn<ChallengeBoardApi["save"]>()) => {
  const api: ChallengeBoardApi = {
    load: vi.fn(() => Promise.resolve(initial)),
    save,
  };
  render(<ChallengeBoard api={api} />);
  return { api, save };
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
  it("wendet clientId zu id an und sendet danach nur die echte ID", async () => {
    const user = userEvent.setup();
    const initial = snapshot([]);
    const saved = challenge("server-id", "Neue Challenge");
    const save = vi.fn<ChallengeBoardApi["save"]>()
      .mockResolvedValueOnce(responseFor(snapshot([saved], 2), { "client-id": "server-id" }))
      .mockResolvedValueOnce(responseFor(snapshot([challenge("server-id", "Umbenannt")], 3)));
    renderBoard(initial, save);

    await user.click(await screen.findByRole("button", { name: "Challenge anlegen" }));
    const row = firstRow();
    const title = within(row).getByLabelText("Titel");
    await user.clear(title);
    await user.type(title, "Neue Challenge");
    await user.click(screen.getByRole("button", { name: "Challenge-Board speichern" }));

    const firstRequest = save.mock.calls[0]?.[0];
    if (firstRequest === undefined) throw new Error("Save-Request fehlt.");
    const firstDefinition = firstRequest.challenges[0];
    if (firstDefinition === undefined) throw new Error("Neue Definition fehlt.");
    expect("clientId" in firstDefinition).toBe(true);
    if ("clientId" in firstDefinition) expect(typeof firstDefinition.clientId).toBe("string");
    expect(firstDefinition).not.toHaveProperty("id");
    expect(screen.getByDisplayValue("Neue Challenge")).toBeInTheDocument();

    await user.clear(screen.getByDisplayValue("Neue Challenge"));
    await user.type(screen.getByLabelText("Titel"), "Umbenannt");
    await user.click(screen.getByRole("button", { name: "Challenge-Board speichern" }));
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
    await user.click(openToggle);
    expect(openToggle).toHaveAttribute("aria-checked", "true");

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
    renderBoard(initial, save);

    await screen.findByDisplayValue("Erste");
    await user.click(screen.getByRole("button", { name: "Erste löschen" }));
    await user.click(screen.getByRole("button", { name: "Challenge-Board speichern" }));

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

  it("zeigt einen revision_conflict mit Serverstand und überschreibt ihn nicht still", async () => {
    const user = userEvent.setup();
    const initial = snapshot([challenge("one", "Lokaler Entwurf")]);
    const foreign = snapshot([challenge("one", "Fremde Änderung"), challenge("two", "Neu von außen", { sortOrder: 1 })], 2);
    const save = vi.fn<ChallengeBoardApi["save"]>().mockRejectedValue({
      code: "revision_conflict",
      currentSnapshot: foreign,
    });
    renderBoard(initial, save);

    const title = await screen.findByDisplayValue("Lokaler Entwurf");
    await user.clear(title);
    await user.type(title, "Mein Entwurf");
    await user.click(screen.getByRole("button", { name: "Challenge-Board speichern" }));

    expect(await screen.findByText("Jemand anderes hat das Board gespeichert.")).toBeInTheDocument();
    expect(screen.getByText("Fremde Änderung")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Mein Entwurf")).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Challenge-Board speichern" })).toBeDisabled();
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
});
