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
});
