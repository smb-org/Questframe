import { describe, expect, it } from "vitest";

import { expiryToLocalInput, resolveLocalExpiry } from "../../../src/admin/time";

describe("resolveLocalExpiry", () => {
  it("converts an ordinary wall-clock time in the channel timezone", async () => {
    await expect(resolveLocalExpiry("2026-08-29T14:30", "Europe/Berlin")).resolves.toEqual({
      kind: "exact",
      expiresAt: "2026-08-29T12:30:00Z",
    });
  });

  it("rejects a wall-clock time skipped by the spring DST jump", async () => {
    const result = await resolveLocalExpiry("2026-03-29T02:30", "Europe/Berlin");

    expect(result.kind).toBe("nonexistent");
  });

  it("offers both absolute instants during the autumn DST overlap", async () => {
    await expect(resolveLocalExpiry("2026-10-25T02:30", "Europe/Berlin")).resolves.toEqual({
      kind: "ambiguous",
      choices: [
        { expiresAt: "2026-10-25T00:30:00Z", offset: "+02:00" },
        { expiresAt: "2026-10-25T01:30:00Z", offset: "+01:00" },
      ],
    });
  });

  it("reports malformed local values without throwing", async () => {
    await expect(resolveLocalExpiry("not-a-date", "Europe/Berlin")).resolves.toEqual({
      kind: "invalid",
    });
  });
});

describe("expiryToLocalInput", () => {
  it("formats a stored instant in the configured channel timezone", async () => {
    await expect(
      expiryToLocalInput("2026-10-25T00:30:00Z", "Europe/Berlin"),
    ).resolves.toBe("2026-10-25T02:30");
  });
});
