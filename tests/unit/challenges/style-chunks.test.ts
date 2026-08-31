import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const styleNames = ["plain-list", "plain-bullets", "plain-numbered", "quest-log"] as const;
const stylesDirectory = path.join(import.meta.dirname, "../../../src/modules/win-challenges/styles");
const challengeLogSource = readFileSync(
  path.join(import.meta.dirname, "../../../src/modules/win-challenges/ui/ChallengeLog.tsx"),
  "utf8",
);

describe("Challenge-Style-Chunks", () => {
  it("legt vier dynamisch importierbare Styles über derselben Basis an", () => {
    const files = styleNames.map((styleName) => path.join(stylesDirectory, `${styleName}.css`));

    expect(files.every((file) => existsSync(file))).toBe(true);
    const css = files.map((file) => (existsSync(file) ? readFileSync(file, "utf8") : ""));
    expect(css.every((source) => source.includes('@import "../../../challenges/challenge-source.css";'))).toBe(true);

    const listStyleTypes = css.slice(0, 3).map((source) => source.match(/list-style-type:\s*([^;]+);/)?.[1]?.trim());
    expect(listStyleTypes).toEqual(["none", "disc", "decimal"]);
    expect(css.slice(0, 3).every((source) => (source.match(/\{/g) ?? []).length === 1)).toBe(true);
  });

  it("baut quest-log ohne Rastergrafik mit Rahmenwinkeln und Rautenmarke", () => {
    const file = path.join(stylesDirectory, "quest-log.css");
    const source = existsSync(file) ? readFileSync(file, "utf8") : "";

    expect(source).toContain('.challenge-source[data-style="quest-log"]');
    expect(source).toContain("::before");
    expect(source).toContain("::after");
    expect(source).toContain("border");
    expect(source).toContain('content: "◆";');
    expect(source).not.toMatch(/url\(/);
  });

  it("hält Sound und Style-Registry aus dem herauslösbaren Modul heraus", () => {
    expect(challengeLogSource).not.toMatch(/(?:from|import)\s+["'][^"']*(?:audio|ceremon)[^"']*["']/i);
    expect(challengeLogSource).not.toMatch(/styleId\s*!==|styleId\s*===|styleId\s*==|styleId\s*==/);
  });
});
