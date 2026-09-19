import { describe, expect, it, vi } from "vitest";

import type { ChallengeSetV1 } from "../../../src/modules/win-challenges/contracts/schemas";
import { MAX_TIMER_REMAIN_MS } from "../../../src/modules/win-challenges/contracts/predicates";
import {
  MAX_CHALLENGE_SET_FILE_BYTES,
  downloadChallengeSet,
  readChallengeSetFile,
} from "../../../src/admin/ui/challengeSetFiles";

const instant = "2026-09-14T12:00:00.000Z";

const challenge = {
  title: "Wasser trinken",
  kind: "counter" as const,
  unit: null,
  targetCount: 10,
  timerTotalMs: null,
  sortOrder: 0,
  step: 1,
  hidden: false,
};

const payload = (overrides: Partial<ChallengeSetV1> = {}): ChallengeSetV1 => ({
  schemaVersion: 1,
  name: "Elden Ring Bingo",
  createdAt: instant,
  challenges: [challenge],
  ...overrides,
});

const file = (contents: string, name = "elden-ring.json"): File => new File([contents], name, { type: "application/json" });

describe("Challenge-Set-Dateien", () => {
  it("liest ein gültiges Set und bewahrt den Dateinamen", async () => {
    const result = await readChallengeSetFile(file(JSON.stringify(payload())));

    expect(result).toEqual({ payload: payload(), fileName: "elden-ring.json" });
  });

  it("akzeptiert genau 64 KiB, bevor der JSON-Inhalt geparst wird", async () => {
    const json = JSON.stringify(payload());
    const padded = `${json}${" ".repeat(MAX_CHALLENGE_SET_FILE_BYTES - json.length)}`;
    const input = file(padded);

    expect(input.size).toBe(MAX_CHALLENGE_SET_FILE_BYTES);
    await expect(readChallengeSetFile(input)).resolves.toMatchObject({ fileName: "elden-ring.json" });
  });

  it("weist eine Datei über 64 KiB vor dem Lesen mit Größenfehler zurück", async () => {
    const text = vi.fn<() => Promise<string>>();
    const input = { name: "zu-gross.json", size: MAX_CHALLENGE_SET_FILE_BYTES + 1, text };

    await expect(readChallengeSetFile(input)).rejects.toThrow("Set-Datei: zu-gross.json ist zu groß (maximal 64 KiB).");
    expect(text).not.toHaveBeenCalled();
  });

  it("benennt kaputtes JSON als Fehler am Datei-Feld", async () => {
    await expect(readChallengeSetFile(file("{ kaputt", "kaputt.json"))).rejects.toThrow("Set-Datei: JSON ist ungültig.");
  });

  it("benennt eine fremde Schema-Version am Versions-Feld", async () => {
    await expect(readChallengeSetFile(file(JSON.stringify({ ...payload(), schemaVersion: 2 })))).rejects.toThrow(
      "Set-Datei schemaVersion: Version 2 wird nicht unterstützt; erwartet wird Version 1.",
    );
  });

  it("benennt 31 Aufgaben am Aufgaben-Feld", async () => {
    await expect(readChallengeSetFile(file(JSON.stringify({ ...payload(), challenges: Array.from({ length: 31 }, (_, index) => ({ ...challenge, title: `Challenge ${String(index)}` })) })))).rejects.toThrow(
      "Set-Datei challenges: 31 Aufgaben erkannt; maximal 30 sind erlaubt.",
    );
  });

  it("nennt unbekannte oder ungültige Felder im Validierungsfehler", async () => {
    await expect(readChallengeSetFile(file(JSON.stringify({ ...payload(), challenges: [{ ...challenge, targetCount: 0 }] })))).rejects.toThrow(
      "Set-Datei challenges.0.targetCount:",
    );
  });

  it("klemmt beim Lesen nur eine numerisch überzogene Restzeit an die Grenze", async () => {
    const result = await readChallengeSetFile(file(JSON.stringify(payload({
      challenges: [{
        ...challenge,
        progress: {
          currentCount: 0,
          bestCount: 0,
          state: "pending",
          timerRemainMs: -MAX_TIMER_REMAIN_MS - 123_456,
          completedAt: null,
        },
      }],
    }))));

    expect(result.payload.challenges[0]?.progress?.timerRemainMs).toBe(-MAX_TIMER_REMAIN_MS);
  });

  it.each<[string, Record<string, unknown>]>([
    ["fehlendes Feld", { currentCount: 0, bestCount: 0, state: "pending", completedAt: null }],
    ["falscher Typ", { currentCount: 0, bestCount: 0, state: "pending", timerRemainMs: "zu viel", completedAt: null }],
  ])("lehnt beim Lesen einen echten Schemafehler trotz Toleranz ab (%s)", async (_name, progress) => {
    await expect(readChallengeSetFile(file(JSON.stringify(payload({
      challenges: [{ ...challenge, progress } as unknown as ChallengeSetV1["challenges"][number]],
    }))))).rejects.toThrow("Set-Datei challenges.0.progress.timerRemainMs:");
  });

  it("lehnt unbekannte Schlüssel auch neben einer überzogenen Restzeit ab", async () => {
    await expect(readChallengeSetFile(file(JSON.stringify(payload({
      challenges: [{
        ...challenge,
        unexpected: true,
        progress: {
          currentCount: 0,
          bestCount: 0,
          state: "pending",
          timerRemainMs: -MAX_TIMER_REMAIN_MS - 1,
          completedAt: null,
        },
      } as unknown as ChallengeSetV1["challenges"][number]],
    }))))).rejects.toThrow("Set-Datei challenges.0:");
  });

  it("legt den Set-Namen mit Datum im Download-Dateinamen ab", () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    downloadChallengeSet(payload({ name: "Elden Ring / Bingo" }), new Date("2026-09-14T12:00:00.000Z"));

    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:test");
    const anchor = click.mock.instances[0];
    expect(anchor).toHaveAttribute("download", "Elden-Ring-Bingo-2026-09-14.json");
  });
});
