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
  it("liefert das eigene surface-Preset und das gekoppelte bare-Preset", () => {
    expect(sourceCss).toContain("--wc-surface: rgba(13, 16, 19, 0.88);");
    expect(sourceCss).toContain("--wc-bare-shadow: none;");
    expect(sourceCss).toContain("font-weight: 500;");
    expect(sourceCss).toContain("--wc-title-weight: 600;");

    const bareBlock = sourceCss.match(
      /\[data-theme-mode\]\[data-surface-mode="bare"\]\s*\{([^}]*)\}/,
    )?.[1] ?? "";
    expect(bareBlock).toContain("--wc-surface: transparent;");
    expect(bareBlock).toContain("--wc-font-size: 14px;");
    expect(bareBlock).toContain("--wc-title-size: var(--wc-bare-title-size);");
    expect(bareBlock).toContain("--wc-timer-size: var(--wc-bare-timer-size);");
    expect(bareBlock).toContain("--wc-meta-size: var(--wc-bare-meta-size);");
    expect(bareBlock).toContain(
      "--wc-bare-shadow: 0 1px 2px rgba(0, 0, 0, 0.9), 0 0 6px rgba(0, 0, 0, 0.7);",
    );
    expect(bareBlock).toContain("--wc-title-weight: 700;");
  });

  it("gibt Haarlinie, Fortschrittsbalken und Timer-Puls denselben bare-Halo", () => {
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
