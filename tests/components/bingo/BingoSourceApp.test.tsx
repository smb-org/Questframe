import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BingoSourceApp } from "../../../src/bingo/BingoSourceApp";
import { OVERLAY_SOCKET_PROTOCOL } from "../../../src/shared/contracts/protocol";

const token = "A".repeat(43);

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly protocols: string[];
  private readonly listeners = new Map<string, Array<(event: Event & { data?: unknown }) => void>>();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }

  addEventListener(type: string, callback: (event: Event & { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data?: unknown): void {
    for (const callback of this.listeners.get(type) ?? []) callback({ type, data } as Event & { data?: unknown });
  }

  close(): void {}
  send(): void {}
}

const update = (ceremony?: unknown) => ({
  type: "bingo_update",
  board: {
    card: {
      title: "Diagonale",
      size: 3,
      cells: Array.from({ length: 9 }, (_, index) => ({ id: `c${String(index)}`, text: `Feld ${String(index)}` })),
    },
    marks: ["c0", "c4", "c8"],
    cardRevision: 1,
    markRevision: 3,
    generation: 0,
    style: "marker",
    placement: { x: 12, y: 4, scale: 1.25 },
  },
  ...(ceremony === undefined ? {} : { ceremony }),
});

const deliver = async (socket: FakeWebSocket | undefined, input: unknown): Promise<void> => {
  await act(async () => {
    socket?.emit("message", JSON.stringify(input));
    await Promise.resolve();
  });
};

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  window.history.replaceState({}, "", `/overlay/bingo#token=${token}`);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BingoSourceApp", () => {
  it("rendert markierte Linien aus dem aktuellen Stand ohne beim Snapshot eine Zeremonie zu erfinden", async () => {
    const loadStyle = vi.fn(() => Promise.resolve());
    render(<BingoSourceApp loadStyle={loadStyle} />);
    const socket = FakeWebSocket.instances[0];
    await deliver(socket, update());

    expect(await screen.findByRole("grid", { name: "Diagonale" })).toBeInTheDocument();
    expect(screen.getAllByRole("gridcell").filter((cell) => cell.getAttribute("data-line-complete") === "true")).toHaveLength(3);
    expect(document.querySelector(".bingo-source-ceremony")).not.toHaveAttribute("data-ceremony-type");
    expect(loadStyle).toHaveBeenCalledWith("marker");
    expect(socket?.url).toContain("/ws/bingo");
    expect(socket?.protocols).toEqual([OVERLAY_SOCKET_PROTOCOL, token]);
  });

  it("zeigt eine Zeremonie nur, wenn das Bingo-Update sie ausdrücklich mitsendet", async () => {
    const { rerender } = render(<BingoSourceApp loadStyle={() => Promise.resolve()} />);
    await deliver(FakeWebSocket.instances[0], update({ lines: [{ kind: "diag", index: 0 }], fullCard: false }));

    expect(await screen.findByText("BINGO!")).toBeInTheDocument();
    expect(document.querySelector(".bingo-source-ceremony")).toHaveAttribute("data-ceremony-type", "line");
    expect(document.querySelectorAll('.bingo-source__line-outline[data-ceremony-line="true"]')).toHaveLength(1);

    const cleared = update();
    cleared.board.marks = [];
    cleared.board.markRevision = 4;
    await deliver(FakeWebSocket.instances[0], cleared);
    rerender(<BingoSourceApp loadStyle={() => Promise.resolve()} />);
    expect(screen.queryByText("BINGO!")).not.toBeInTheDocument();
  });

  it("zeigt nach einer Verbindungstrennung beim Snapshot keine alte Zeremonie erneut", async () => {
    render(<BingoSourceApp loadStyle={() => Promise.resolve()} />);
    const firstSocket = FakeWebSocket.instances[0];
    await deliver(firstSocket, update({ lines: [{ kind: "diag", index: 0 }], fullCard: false }));
    expect(document.querySelector(".bingo-source-ceremony")).toHaveAttribute("data-ceremony-type", "line");

    act(() => { firstSocket?.emit("close"); });
    expect(document.querySelector(".bingo-source-ceremony")).toBeNull();
    await deliver(firstSocket, update());

    expect(screen.getByRole("grid", { name: "Diagonale" })).toBeInTheDocument();
    expect(document.querySelector(".bingo-source-ceremony")).not.toHaveAttribute("data-ceremony-type");
    expect(screen.queryByText("BINGO!")).not.toBeInTheDocument();
  });

  it("leitet den Broadcast-Zähler aus den angekreuzten Feldern ab", async () => {
    const current = update();
    current.board.style = "broadcast";
    render(<BingoSourceApp loadStyle={() => Promise.resolve()} />);

    await deliver(FakeWebSocket.instances[0], current);

    expect(await screen.findByText("3/9")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Bingo-Fortschritt" })).toHaveAttribute("aria-valuenow", "3");
  });

  it("zeigt Broadcast-Zeremonien bei reduzierter Bewegung ohne Animation", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const current = update({ lines: [{ kind: "diag", index: 0 }], fullCard: false });
    current.board.style = "broadcast";
    render(<BingoSourceApp loadStyle={() => Promise.resolve()} />);

    await deliver(FakeWebSocket.instances[0], current);

    expect(await screen.findByText("BINGO!")).toBeInTheDocument();
    expect(document.querySelector(".bingo-source-ceremony")).toHaveAttribute("data-ceremony-motion", "static");
  });
});
