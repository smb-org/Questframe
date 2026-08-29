import path from "node:path";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// This file lives under tests/config/ (rather than next to its two siblings
// at the project root) purely so tsconfig.json's `include: ["tests", ...]`
// picks it up for typed linting/type-checking without needing to touch
// tsconfig.json. `root` below repoints all relative paths (main, wrangler
// config, test include, coverage output) back at the project root so this
// file behaves exactly as if it were a third root-level sibling of
// vitest.config.ts / vitest.worker.config.ts.
const projectRoot = path.resolve(import.meta.dirname, "../..");

// This is the SECOND Worker testing environment (see vitest.worker.config.ts for
// the first). vitest.worker.config.ts intentionally binds placeholder secrets
// (`replace-...`) so `src/worker/env.ts` always reports the deployment as
// misconfigured; that is exactly what its tests exercise (the 503 `/healthz`
// branch, the `?error=misconfigured` OAuth-start redirect). It can never reach
// the "app thinks it is correctly configured" success paths: the real
// `/healthz` 200 branch and the full `/auth/twitch/start` redirect (nonce,
// PKCE, code_challenge, signed state, binding cookie) stay completely
// unexercised if that is the only Worker environment under test.
//
// Rather than juggling two binding sets inside one config (the plugin only
// accepts one static `miniflare.bindings` object per `cloudflareTest()` call,
// so a single config cannot express both an intentionally-broken and a
// correctly-configured deployment at once), this file is a second, sibling
// Vitest config with its own `cloudflareTest()` instance and its own real,
// schema-valid secret values. Vitest 4 does support multiple `test.projects`
// inside one config, but that would still require one `cloudflareTest()` vite
// plugin instance per project (each running its own workerd pool), so it buys
// no less code than a second file while adding project/coverage-merging
// complexity we don't need. A second top-level config file is the lower
// friction option and mirrors how this repo already separates the browser
// (jsdom) and Worker (workerd) tests into vitest.config.ts /
// vitest.worker.config.ts.
//
// `wrangler.environment: "staging"` re-uses the `env.staging` block already
// declared in wrangler.jsonc (APP_ENV, RELEASE_STAGE, the Durable Object and
// rate-limiter bindings, the assets binding) instead of re-declaring all of
// that here. Only the secret bindings--which wrangler.jsonc never stores in
// plaintext--are supplied locally, with real, schema-valid values so
// `getMissingBindings()` returns an empty array.
export default defineConfig({
  root: projectRoot,
  plugins: [
    cloudflareTest({
      main: path.resolve(projectRoot, "src/worker/index.ts"),
      wrangler: { configPath: path.resolve(projectRoot, "wrangler.jsonc"), environment: "staging" },
      miniflare: {
        bindings: {
          TWITCH_CLIENT_ID: "staging-twitch-client-id",
          TWITCH_CLIENT_SECRET: "staging-test-twitch-client-secret",
          BROADCASTER_ID: "98765432109876543210",
          PUBLIC_ORIGIN: "https://hud.staging.example.com",
          CAPSULE_ID: "irl-stream-hud-staging-test",
          CAPSULE_NAME: "IRL Stream HUD Staging Test",
          TIMEZONE: "Europe/Berlin",
          SESSION_COOKIE_KEYS: JSON.stringify({
            active: { id: "staging-cookie", key: "EmgaMHJwNyTCZLDEH6wMPFn5vvFGl47ScorLEaETBbM" },
          }),
          SESSION_ENCRYPTION_KEYS: JSON.stringify({
            active: { id: "staging-token", key: "sjM_S1BGn9DPMnK6oYaqc3-1y_4FA27S74yCA0YTXk8" },
          }),
          OVERLAY_TOKEN_PEPPER: "xKR3mZmF9L9CGuS3yDNtQnEXHB74bdAz8hsDx6NIa0E",
        },
      },
    }),
  ],
  test: {
    include: ["tests/worker/configured-environment.test.ts"],
    coverage: {
      // Workerd does not expose the Node inspector session required by V8 coverage.
      provider: "istanbul",
      include: ["src/worker/**/*.ts", "src/channel/**/*.ts"],
      exclude: ["**/*.d.ts"],
      reportsDirectory: "./coverage/worker-configured",
    },
  },
});
