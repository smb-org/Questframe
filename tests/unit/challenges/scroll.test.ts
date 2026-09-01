import { describe, expect, it } from "vitest";

import { pingPongOffset, rephase, resolveFocus } from "../../../src/modules/win-challenges/ui/scroll";

describe("Challenge-Scroll", () => {
  it("fährt linear, hält an den Enden und kehrt nach einer Periode zurück", () => {
    const distance = 100;
    const speed = 10;
    const travel = 10_000;
    const hold = 2_000;
    const period = 2 * (travel + hold);

    expect(pingPongOffset(0, distance, speed, hold)).toBe(0);
    expect(pingPongOffset(1_999, distance, speed, hold)).toBe(0);
    expect(pingPongOffset(2_000, distance, speed, hold)).toBe(0);
    expect(pingPongOffset(7_000, distance, speed, hold)).toBe(50);
    expect(pingPongOffset(12_000, distance, speed, hold)).toBe(100);
    expect(pingPongOffset(13_999, distance, speed, hold)).toBe(100);
    expect(pingPongOffset(19_000, distance, speed, hold)).toBe(50);
    expect(pingPongOffset(period, distance, speed, hold)).toBe(0);
  });

  it("rephasiert den aktuellen Offset mit beibehaltener Richtung", () => {
    const forwardPhase = rephase(5_000, 100, 10, 30, "forward");
    const backwardPhase = rephase(5_000, 100, 10, 30, "backward");

    expect(pingPongOffset(5_000 + forwardPhase, 100, 10)).toBeCloseTo(30);
    expect(pingPongOffset(5_000 + backwardPhase, 100, 10)).toBeCloseTo(30);
    expect(pingPongOffset(5_000 + forwardPhase + 1, 100, 10)).toBeGreaterThan(30);
    expect(pingPongOffset(5_000 + backwardPhase + 1, 100, 10)).toBeLessThan(30);
  });

  it("hält ein sichtbares Ziel und berechnet für ein außerhalb liegendes Ziel den Zieloffset", () => {
    expect(resolveFocus({ top: 40, bottom: 70 }, { height: 100 }, 25, 200)).toEqual({
      outside: false,
      targetOffset: 25,
    });
    expect(resolveFocus({ top: 180, bottom: 220 }, { height: 100 }, 0, 200)).toEqual({
      outside: true,
      targetOffset: 120,
    });
  });
});
