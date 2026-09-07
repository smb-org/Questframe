import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_CHALLENGE_SOCKETS,
  MAX_COMPOSITE_SOCKETS,
  MAX_DOCK_SOCKETS,
  MAX_OVERLAY_SOCKETS,
} from "../../../src/shared/contracts/api";

type RateLimit = {
  name: string;
  simple: { limit: number; period: number };
};

type WranglerConfig = {
  ratelimits: RateLimit[];
  env: Record<string, { ratelimits: RateLimit[] }>;
};

const config = JSON.parse(
  readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8"),
) as WranglerConfig;

// Schlimmster gutartiger Fall: nach einem Deploy verbinden alle Overlay-, Composite-
// und Challenge-Quellen gleichzeitig neu, im Zweifel von derselben Adresse. Die
// Limiter dürfen genau das nicht abwürgen — sonst kostet jedes Anheben der
// Socket-Grenzen still die Selbstheilung.
const reloadBurst = MAX_OVERLAY_SOCKETS + MAX_COMPOSITE_SOCKETS + MAX_CHALLENGE_SOCKETS;

const minimums: Record<string, number> = {
  // Der Kapsel-Eimer sieht die Bursts aller Adressen zusammen, deshalb doppelt.
  OVERLAY_CAPSULE_LIMITER: reloadBurst * 2,
  OVERLAY_TOKEN_LIMITER: reloadBurst,
  OVERLAY_IP_LIMITER: reloadBurst,
  DOCK_TOKEN_LIMITER: MAX_DOCK_SOCKETS,
  DOCK_IP_LIMITER: MAX_DOCK_SOCKETS,
};

describe("Wrangler Token- und IP-Rate-Limits", () => {
  it.each([
    ["local", config.ratelimits],
    ["staging", config.env.staging?.ratelimits],
    ["production", config.env.production?.ratelimits],
  ])("lässt in %s Luft für ein gleichzeitiges Neuverbinden aller Quellen", (environment, rateLimits) => {
    expect(rateLimits, `ratelimits fehlen in ${environment}`).toBeDefined();
    for (const [name, minimum] of Object.entries(minimums)) {
      const limiter = (rateLimits ?? []).find((entry) => entry.name === name);
      expect(limiter, `${name} fehlt in ${environment}`).toBeDefined();
      expect(limiter?.simple.period, `${name} in ${environment}`).toBe(10);
      expect(
        limiter?.simple.limit ?? 0,
        `${name} in ${environment} lässt kein vollständiges Neuverbinden zu`,
      ).toBeGreaterThanOrEqual(minimum);
    }
  });

  it("stimmt mit den in den Worker-Tests gespiegelten Budgets überein", () => {
    // workerd hat kein Dateisystem, tests/worker/challenge-sockets.test.ts hält
    // die beiden Werte deshalb als Konstanten. Hier fällt auf, wenn sie
    // auseinanderlaufen.
    const budget = (name: string): number =>
      config.ratelimits.find((entry) => entry.name === name)?.simple.limit ?? 0;
    expect(budget("OVERLAY_IP_LIMITER")).toBe(100);
    expect(budget("OVERLAY_CAPSULE_LIMITER")).toBe(300);
  });

  it("hält alle Umgebungen auf denselben Budgets", () => {
    // Divergierende Limits machen Staging als Generalprobe wertlos.
    const budgetsOf = (rateLimits: RateLimit[] | undefined): Record<string, number> =>
      Object.fromEntries((rateLimits ?? []).map((entry) => [entry.name, entry.simple.limit]));
    expect(budgetsOf(config.env.staging?.ratelimits)).toEqual(budgetsOf(config.ratelimits));
    expect(budgetsOf(config.env.production?.ratelimits)).toEqual(budgetsOf(config.ratelimits));
  });
});
