import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const verifier = path.join(projectRoot, "scripts/verify-deployment-config.mjs");

describe("deployment configuration preflight", () => {
  it("rejects placeholder values before Wrangler can upload them", () => {
    const result = spawnSync(
      process.execPath,
      [verifier, "validate-env", "staging", ".env.staging.example"],
      { cwd: projectRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Platzhalter");
    expect(result.stderr).not.toContain("replace-with-staging-twitch-client-secret");
  });

  it("rejects a generated build for the wrong Cloudflare environment", () => {
    const result = spawnSync(
      process.execPath,
      [
        verifier,
        "validate-build",
        "staging",
        "tests/fixtures/deployment/wrong-environment.json",
      ],
      { cwd: projectRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("APP_ENV");
    expect(result.stderr).toContain("staging");
  });

  it("rejects a deployment file that is entirely missing its required values, and names them", () => {
    const result = spawnSync(
      process.execPath,
      [verifier, "validate-env", "staging", "tests/fixtures/deployment/missing-values.env"],
      { cwd: projectRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Werte fehlen");
    for (const name of [
      "TWITCH_CLIENT_ID",
      "TWITCH_CLIENT_SECRET",
      "BROADCASTER_ID",
      "PUBLIC_ORIGIN",
      "CAPSULE_ID",
      "CAPSULE_NAME",
      "TIMEZONE",
      "SESSION_COOKIE_KEYS",
      "SESSION_ENCRYPTION_KEYS",
      "OVERLAY_TOKEN_PEPPER",
    ]) {
      expect(result.stderr).toContain(name);
    }
  });

  it("accepts a complete, schema-valid deployment file", () => {
    const result = spawnSync(
      process.execPath,
      [verifier, "validate-env", "staging", "tests/fixtures/deployment/complete-valid.env"],
      { cwd: projectRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Verified private staging deployment values.");
  });
});
