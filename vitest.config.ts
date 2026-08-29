import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.test.{ts,tsx}", "tests/components/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["src/shared/**/*.{ts,tsx}", "src/admin/**/*.{ts,tsx}", "src/overlay/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "**/*.d.ts"],
      // Reviewed V1 baseline: behavior-driven tests cover every critical publication,
      // auth and overlay path; these floors ratchet structural regressions without
      // rewarding tests that only execute incidental React/defensive-parser branches.
      thresholds: {
        statements: 90,
        branches: 87,
        functions: 88,
        lines: 92
      }
    }
  }
});
