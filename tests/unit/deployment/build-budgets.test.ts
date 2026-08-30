import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  assetSizeKey,
  evaluateBuildBudgets,
} from "../../../scripts/lib/build-budgets.mjs";
import { sumDirectoryBytes } from "../../../scripts/lib/build-budget-assets.mjs";

const lookupFrom = (sizes: Record<string, number>) => (target: string) => sizes[target] ?? 0;
type BudgetDeclaration = Parameters<typeof evaluateBuildBudgets>[2][number];

describe("Build-Budget-Gate", () => {
  it("scheitert bei einem ungedeckten Dynamic Entry und nennt den Key", async () => {
    const manifest = {
      "index.html": { file: "index.html" },
      "new-route": { file: "new-route.js", isDynamicEntry: true },
    };

    const result = await evaluateBuildBudgets(manifest, lookupFrom({}), []);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("new-route");
  });

  it("scheitert bei einem ungedeckten isEntry und nennt den Key", async () => {
    const manifest = {
      "index.html": { file: "index.html", isEntry: true },
    };

    const result = await evaluateBuildBudgets(manifest, lookupFrom({}), []);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("index.html");
  });

  it("akzeptiert einen deklarierten Dynamic Entry", async () => {
    const manifest = {
      "index.html": { file: "index.html" },
      "new-route": { file: "new-route.js", isDynamicEntry: true },
    };

    const result = await evaluateBuildBudgets(
      manifest,
      lookupFrom({ "new-route.js": 10, [assetSizeKey("audio")]: 0 }),
      [{
        type: "surface",
        key: "new-route",
        javascriptLabel: "Neue Route JavaScript",
        javascriptBudget: 100,
        transferLabel: "Neue Route Transfer",
        transferBudget: 100,
        transferAssets: ["audio"],
      }],
    );

    expect(result.ok).toBe(true);
  });

  it("verlangt bei Dynamic Entries genau eine Deklaration", async () => {
    const manifest = { route: { file: "route.js", isDynamicEntry: true } };
    const declaration = {
      type: "surface" as const,
      key: "route",
      javascriptLabel: "Route JavaScript",
      javascriptBudget: 100,
      transferLabel: "Route Transfer",
      transferBudget: 100,
    };
    const result = await evaluateBuildBudgets(
      manifest,
      lookupFrom({ "route.js": 10 }),
      [declaration, { ...declaration }],
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("multiple declarations");
    expect(result.errors.join("\n")).toContain("route");
  });

  it("verlangt fuer exempt eine Begruendung", async () => {
    const manifest = { route: { file: "route.js", isDynamicEntry: true } };
    const result = await evaluateBuildBudgets(
      manifest,
      lookupFrom({}),
      [{ type: "exempt", key: "route", reason: "" }],
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("needs a reason");
  });

  it("nimmt bei variantMax das Maximum der vollen JS/CSS-Closures", async () => {
    const manifest = {
      styleA: { file: "a.js", isDynamicEntry: true, imports: ["shared"], css: ["a.css"] },
      styleB: { file: "b.js", isDynamicEntry: true, imports: ["shared"], css: ["b.css"] },
      shared: { file: "shared.js", css: ["shared.css"] },
    };
    const result = await evaluateBuildBudgets(
      manifest,
      lookupFrom({
        "a.js": 100,
        "b.js": 500,
        "shared.js": 50,
        "a.css": 20,
        "b.css": 40,
        "shared.css": 30,
      }),
      [{ type: "variantMax", label: "Challenge-Stile", keys: ["styleA", "styleB"], budget: 700 }],
    );

    expect(result.ok).toBe(true);
    expect(result.checks[0]?.actual).toBe(620);
    expect(result.checks[0]?.actual).not.toBe(820);
  });

  it("erlaubt eine leere optionale variantMax-Gruppe, aber keine leere Pflichtgruppe", async () => {
    const optional = await evaluateBuildBudgets(
      {},
      lookupFrom({}),
      [{ type: "variantMax", label: "Zukuenftige Stile", keys: [], optional: true, budget: 100 }],
    );
    const required = await evaluateBuildBudgets(
      {},
      lookupFrom({}),
      [{ type: "variantMax", label: "Zukuenftige Stile", keys: [], budget: 100 }],
    );

    expect(optional.ok).toBe(true);
    expect(required.ok).toBe(false);
    expect(required.errors.join("\n")).toContain("Zukuenftige Stile");
  });

  it("meldet eine fehlende optionale Surface als PEND", async () => {
    const result = await evaluateBuildBudgets(
      {},
      lookupFrom({}),
      [{
        type: "surface",
        key: "future-route",
        label: "Future Route",
        javascriptLabel: "Future Route JavaScript",
        javascriptBudget: 100,
        transferLabel: "Future Route Transfer",
        transferBudget: 100,
        optional: true,
      }],
    );

    expect(result.ok).toBe(true);
    expect(result.declarationResults[0]?.status).toBe("PEND");
    expect(result.checks[0]?.status).toBe("PEND");
  });

  it("prueft eine Surface ohne Transferbudget nur auf JavaScript", async () => {
    const result = await evaluateBuildBudgets(
      { route: { file: "route.js", isDynamicEntry: true } },
      lookupFrom({ "route.js": 10 }),
      [{
        type: "surface",
        key: "route",
        javascriptBudget: 100,
      }],
    );

    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.label).toBe("route JavaScript");
  });

  it("verlangt ein Transferbudget fuer deklarierte Transfer-Assets", async () => {
    const result = await evaluateBuildBudgets(
      { route: { file: "route.js", isDynamicEntry: true } },
      lookupFrom({ "route.js": 10, [assetSizeKey("audio")]: 0 }),
      [{
        type: "surface",
        key: "route",
        javascriptBudget: 100,
        transferAssets: ["audio"],
      }],
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("route");
    expect(result.errors.join("\n")).toContain("transferBudget");
  });

  it("verwendet kein fremdes Feld als JavaScriptbudget", async () => {
    const result = await evaluateBuildBudgets(
      { route: { file: "route.js", isDynamicEntry: true } },
      lookupFrom({ "route.js": 10 }),
      [{
        type: "surface",
        key: "route",
        budget: 100,
        transferBudget: 100,
      } as unknown as BudgetDeclaration],
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("javascriptBudget");
    expect(result.errors.join("\n")).toContain("route");
  });

  it("verwendet bei variantMax kein fremdes Feld als Budget", async () => {
    const result = await evaluateBuildBudgets(
      { route: { file: "route.js", isDynamicEntry: true } },
      lookupFrom({ "route.js": 10 }),
      [{
        type: "variantMax",
        label: "Routen",
        keys: ["route"],
        maximum: 100,
      } as unknown as BudgetDeclaration],
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("budget");
    expect(result.errors.join("\n")).toContain("Routen");
  });

  it("rechnet Audio-Bytes in den Transfer der deklarierenden Surface ein", async () => {
    const manifest = {
      route: { file: "route.js", isDynamicEntry: true },
    };
    const result = await evaluateBuildBudgets(
      manifest,
      lookupFrom({ "route.js": 100, [assetSizeKey("audio")]: 37 }),
      [{
        type: "surface",
        key: "route",
        javascriptLabel: "Route JavaScript",
        javascriptBudget: 200,
        transferLabel: "Route Transfer",
        transferBudget: 150,
        transferAssets: ["audio"],
      }],
    );
    const withoutAudio = await evaluateBuildBudgets(
      manifest,
      lookupFrom({ "route.js": 100, [assetSizeKey("audio")]: 0 }),
      [{
        type: "surface",
        key: "route",
        javascriptLabel: "Route JavaScript",
        javascriptBudget: 200,
        transferLabel: "Route Transfer",
        transferBudget: 150,
        transferAssets: ["audio"],
      }],
    );

    expect(result.checks.find((check) => check.label === "Route Transfer")?.actual).toBe(137);
    expect(withoutAudio.checks.find((check) => check.label === "Route Transfer")?.actual).toBe(100);
    expect(withoutAudio.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("setzt ein fehlendes Audio-Verzeichnis mit 0 Bytes an", async () => {
    const missingDirectory = path.join(import.meta.dirname, "__missing-build-budget-sounds__");

    await expect(sumDirectoryBytes(missingDirectory)).resolves.toBe(0);
  });

  it("schlaegt bei einem ueberschrittenen Budget fehl", async () => {
    const result = await evaluateBuildBudgets(
      { route: { file: "route.js", isDynamicEntry: true } },
      lookupFrom({ "route.js": 101 }),
      [{
        type: "surface",
        key: "route",
        javascriptLabel: "Route JavaScript",
        javascriptBudget: 100,
        transferLabel: "Route Transfer",
        transferBudget: 200,
      }],
    );

    expect(result.ok).toBe(false);
    expect(result.checks[0]?.status).toBe("FAIL");
  });
});
