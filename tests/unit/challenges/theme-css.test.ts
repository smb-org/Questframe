import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceCss = readFileSync(
  path.join(import.meta.dirname, "../../../src/challenges/challenge-source.css"),
  "utf8",
);

type CssRuleBlock = {
  selector: string;
  body: string;
};

function parseCssRuleBlocks(css: string): CssRuleBlock[] {
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: CssRuleBlock[] = [];
  const openBlocks: Array<{ selector: string; bodyStart: number }> = [];
  let selectorStart = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < cssWithoutComments.length; index += 1) {
    const character = cssWithoutComments[index];

    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      openBlocks.push({
        selector: cssWithoutComments.slice(selectorStart, index).trim(),
        bodyStart: index + 1,
      });
      selectorStart = index + 1;
    } else if (character === "}") {
      const block = openBlocks.pop();
      if (block !== undefined) {
        blocks.push({
          selector: block.selector,
          body: cssWithoutComments.slice(block.bodyStart, index),
        });
      }
      selectorStart = index + 1;
    } else if (character === ";") {
      selectorStart = index + 1;
    }
  }

  return blocks.filter(({ body }) => !/[{}]/.test(body));
}

function splitCssSelectorList(selectorList: string): string[] {
  const selectors: string[] = [];
  let selectorStart = 0;
  let parenthesesDepth = 0;
  let bracketDepth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < selectorList.length; index += 1) {
    const character = selectorList[index];

    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "(") {
      parenthesesDepth += 1;
    } else if (character === ")") {
      parenthesesDepth = Math.max(0, parenthesesDepth - 1);
    } else if (character === "[") {
      bracketDepth += 1;
    } else if (character === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (character === "," && parenthesesDepth === 0 && bracketDepth === 0) {
      selectors.push(selectorList.slice(selectorStart, index).trim());
      selectorStart = index + 1;
    }
  }

  selectors.push(selectorList.slice(selectorStart).trim());
  return selectors.filter((selector) => selector.length > 0);
}

describe("Challenge-Quelle-CSS", () => {
  it("liefert das eigene surface-Preset sowie getrennte bare- und strong-Presets", () => {
    expect(sourceCss).toContain("--wc-surface: rgba(13, 16, 19, 0.88);");
    expect(sourceCss).toContain("--wc-bare-shadow: none;");
    expect(sourceCss).toContain("font-weight: 500;");
    expect(sourceCss).toContain("--wc-title-weight: 600;");

    const bareBlock = sourceCss.match(
      /\[data-theme-mode\]\[data-surface-mode="bare"\]\s*\{([^}]*)\}/,
    )?.[1] ?? "";
    // Das bare-Preset darf die Flaeche NICHT selbst auf transparent setzen: die
    // Deckkraft steuert --wc-surface-opacity. Stuende es hier, waeren 25 % und
    // 0 % identisch, weil die Ebene nichts mehr zu malen haette.
    expect(bareBlock).not.toContain("--wc-surface:");
    expect(bareBlock).toContain("--wc-font-size: var(--wc-bare-font-size);");
    expect(bareBlock).toContain("--wc-title-size: var(--wc-bare-title-size);");
    expect(bareBlock).toContain("--wc-timer-size: var(--wc-bare-timer-size);");
    expect(bareBlock).toContain("--wc-meta-size: var(--wc-bare-meta-size);");
    expect(bareBlock).not.toContain("font-weight");
    expect(bareBlock).not.toContain("text-shadow");
    expect(bareBlock).not.toContain("--wc-bare-shadow");

    const strongBlock = sourceCss.match(
      /\[data-theme-mode\]\[data-text-emphasis="strong"\]\s*\{([^}]*)\}/,
    )?.[1] ?? "";
    expect(strongBlock).toContain(
      "--wc-bare-shadow: 0 1px 2px rgba(0, 0, 0, 0.9), 0 0 6px rgba(0, 0, 0, 0.7);",
    );
    expect(strongBlock).toContain("--wc-title-weight: 700;");
    expect(strongBlock).toContain("--wc-label-weight: 700;");
    expect(strongBlock).toContain("font-weight: 700;");
    expect(strongBlock).toContain("text-shadow: var(--wc-bare-shadow);");
  });

  it("blendet erledigte Zeilen ab, ohne ihre Fläche mitzunehmen", () => {
    // `opacity` auf der Zeile hätte die Flächen-Ebene im ::before mit abgeblendet:
    // das Video schiene durch und der Text wäre über hellem Bild kaum lesbar.
    const doneBlock = sourceCss.match(
      /\.challenge-source__row--done \{([^}]*)\}/,
    )?.[1] ?? "";
    expect(doneBlock).not.toContain("opacity");
    expect(sourceCss).toContain(".challenge-source__row--done > * {");
  });

  it("gibt Haarlinie, Fortschrittsbalken und Timer-Puls denselben strong-Halo", () => {
    const bareShadow = "box-shadow: var(--wc-bare-shadow);";
    const hairline = sourceCss.match(/\.challenge-source__header::after[\s\S]*?\{([^}]*)\}/)?.[1] ?? "";
    const progress = sourceCss.match(/\.challenge-source__progress\s*\{([^}]*)\}/)?.[1] ?? "";
    const progressFill = sourceCss.match(/\.challenge-source__progress-fill\s*\{([^}]*)\}/)?.[1] ?? "";
    const criticalTimer = sourceCss.match(
      /\.challenge-source__timer--critical\s*\{[^}]*text-shadow: var\(--wc-bare-shadow\);[^}]*\}/,
    )?.[0] ?? "";

    expect(hairline).toContain(bareShadow);
    expect(progress).toContain(bareShadow);
    expect(progressFill).toContain(bareShadow);
    expect(criticalTimer).toContain("text-shadow: var(--wc-bare-shadow);");
  });

  it("hält Überzeit neutral und reserviert critical für den knappen Timer", () => {
    const overtimeTimer = sourceCss.match(
      /\.challenge-source__timer--expired\s*\{([^}]*)\}/,
    )?.[1] ?? "";

    expect(overtimeTimer).toContain("color: var(--wc-muted);");
    expect(overtimeTimer).not.toContain("var(--wc-critical)");
  });

  it("führt streak loss als Zeremonienklasse ohne eigene Alarmfarbe", () => {
    expect(sourceCss).toContain(".wc-is-streak-loss");
    expect(sourceCss).toContain('[data-ceremony-type="lost"]');
    expect(sourceCss).not.toMatch(/wc-is-streak-loss[\s\S]{0,500}var\(--wc-critical\)/);
  });

  it("zwingt das pflegbare Strafen-Label nicht in Großbuchstaben", () => {
    const penaltyLabel = sourceCss.match(
      /\.challenge-source__penalty-label\s*\{([^}]*)\}/,
    )?.[1] ?? "";

    expect(penaltyLabel).not.toContain("text-transform");
  });

  it('erzwingt data-theme-mode="inherit" fuer jede HUD-zu-WC-Brueckenregel', () => {
    const unscopedSelectors = parseCssRuleBlocks(sourceCss)
      .filter(({ body }) => body.includes("var(--hud-"))
      .flatMap(({ selector }) => splitCssSelectorList(selector))
      .filter((selector) => !selector.includes('[data-theme-mode="inherit"]'))
      .map((selector) => selector.replace(/\s+/g, " ").trim());

    expect(
      unscopedSelectors,
      `Ungescopte HUD-zu-WC-Brueckenregel(n) gefunden: ${unscopedSelectors.join(", ")}`,
    ).toEqual([]);
  });
});
