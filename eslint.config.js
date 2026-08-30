import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    ".wrangler/**",
    "dist/**",
    "coverage/**",
    "node_modules/**",
    "playwright-report/**",
    "test-results/**",
    "worker-configuration.d.ts",
  ]),
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  reactHooks.configs.flat.recommended,
  reactRefresh.configs.vite,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error"
    }
  },
  {
    // Zuschauerpfade dürfen keine Kommandoschicht und kein Zod ins Bundle ziehen;
    // das 120-KiB-Gate des Overlays hält diese Abhängigkeiten nicht aus.
    // Admin und Live bleiben bewusst unbeschränkt, weil sie die Bedienlogik tragen.
    files: ["src/overlay/**/*.{ts,tsx}", "src/challenges/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)modules/win-challenges/(service|repository|adapters|contracts/schemas)(/|$)",
              message: "Zuschauerpfade dürfen die Kommandoschicht, Persistenzadapter und Zod-Schemas nicht importieren.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["vite.config.ts", "vitest.config.ts", "vitest.worker.config.ts", "playwright.config.ts", "scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off"
    }
  },
  {
    files: ["**/*.tsx"],
    rules: {
      "@typescript-eslint/no-confusing-void-expression": "off"
    }
  }
);
