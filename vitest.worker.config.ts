import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts", "tests/unit/auth/**/*.test.ts"],
    coverage: {
      // Workerd does not expose the Node inspector session required by V8 coverage.
      provider: "istanbul",
      include: ["src/worker/**/*.ts", "src/channel/**/*.ts"],
      exclude: ["**/*.d.ts"],
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
