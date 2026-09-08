import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

const placeholderKey = (fill: string): string => `replace-${fill.repeat(35)}`;

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TWITCH_CLIENT_ID: "local-twitch-client-id",
          TWITCH_CLIENT_SECRET: "replace-with-test-twitch-client-secret",
          BROADCASTER_ID: "12345678901234567890",
          PUBLIC_ORIGIN: "http://localhost:5173",
          CAPSULE_ID: "irl-stream-hud-test",
          CAPSULE_NAME: "IRL Stream HUD Test",
          TIMEZONE: "Europe/Berlin",
          SESSION_COOKIE_KEYS: JSON.stringify({
            active: { id: "test-cookie", key: placeholderKey("A") },
          }),
          SESSION_ENCRYPTION_KEYS: JSON.stringify({
            active: { id: "test-encryption", key: placeholderKey("B") },
          }),
          OVERLAY_TOKEN_PEPPER: placeholderKey("C"),
        },
      },
    }),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts", "tests/unit/auth/**/*.test.ts"],
    // Die Rate-Limiter-Tests setzen bewusst 240 sequenzielle Worker-Anfragen ab,
    // damit ein Fenster-Rollover die Prüfabsicht nicht verwässert. Auf einem
    // GitHub-Runner reicht Vitests Standard von 5s dafür nicht zuverlässig; lokal
    // schon. Der Wert betrifft nur die Wartezeit, keine Zusicherung.
    testTimeout: 30_000,
    // tests/worker/configured-environment.test.ts asserts the app behaves as
    // CORRECTLY configured (see vitest.worker-configured.config.ts); it must
    // not also run here, where every binding is an intentional placeholder.
    exclude: [...configDefaults.exclude, "tests/worker/configured-environment.test.ts"],
    coverage: {
      // Workerd does not expose the Node inspector session required by V8 coverage.
      provider: "istanbul",
      include: ["src/worker/**/*.ts", "src/channel/**/*.ts"],
      exclude: ["**/*.d.ts"],
      reportsDirectory: "./coverage/worker",
      // Workerd's Istanbul baseline is intentionally separate from V8's browser
      // instrumentation. Named integration tests remain the correctness gate.
      thresholds: {
        statements: 69,
        branches: 62,
        functions: 81,
        lines: 70
      }
    }
  }
});
