import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

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

describe("Wrangler Token- und IP-Rate-Limits", () => {
  it.each([
    ["local", config.ratelimits],
    ["staging", config.env.staging?.ratelimits],
    ["production", config.env.production?.ratelimits],
  ])("keeps reload headroom in %s", (_environment, rateLimits) => {
    expect(rateLimits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "OVERLAY_CAPSULE_LIMITER",
          simple: { limit: 60, period: 10 },
        }),
        expect.objectContaining({
          name: "OVERLAY_TOKEN_LIMITER",
          simple: { limit: 30, period: 10 },
        }),
        expect.objectContaining({
          name: "DOCK_TOKEN_LIMITER",
          simple: { limit: 30, period: 10 },
        }),
        expect.objectContaining({
          name: "DOCK_IP_LIMITER",
          simple: { limit: 60, period: 10 },
        }),
      ]),
    );
  });
});
