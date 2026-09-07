import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Cloudflares _headers wendet ALLE passenden Regeln an; der Browser erzwingt bei
// mehreren CSP-Headern die Schnittmenge. Ein "frame-ancestors" im Catch-all würde
// die Overlay-Einbettung (OBS, StreamElements) still abschalten — deshalb hier ein
// roter Test statt nur eines Kommentars.
const parseHeaders = (source: string): Map<string, string[]> => {
  const rules = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of source.split("\n")) {
    const line = raw.trimEnd();
    if (line === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      current = [];
      rules.set(line.trim(), current);
      continue;
    }
    if (current !== null) current.push(line.trim());
  }
  return rules;
};

const rules = parseHeaders(
  readFileSync(path.join(process.cwd(), "public/_headers"), "utf8"),
);

const cspOf = (rule: string): string => {
  const lines = rules.get(rule);
  expect(lines, `Regel ${rule} fehlt in public/_headers`).toBeDefined();
  const csp = (lines ?? []).find((line) => line.toLowerCase().startsWith("content-security-policy:"));
  expect(csp, `Regel ${rule} hat keine CSP`).toBeDefined();
  return csp ?? "";
};

describe("public/_headers", () => {
  it("hält frame-ancestors aus dem Catch-all heraus", () => {
    expect(cspOf("/*")).not.toContain("frame-ancestors");
  });

  it("erlaubt Framing für beide Overlay-Regeln", () => {
    for (const rule of ["/overlay", "/overlay/*"]) {
      expect(cspOf(rule)).toContain("frame-ancestors * https: http:");
    }
  });

  it("nutzt keinen Prefix-Glob, der Nicht-Overlay-Pfade einbettbar macht", () => {
    // "/overlay*" träfe auch "/overlay-x", und das rendert per SPA-Fallback die Admin-App.
    expect([...rules.keys()]).not.toContain("/overlay*");
  });

  it("verbietet Framing für die authentifizierten Oberflächen", () => {
    for (const rule of ["/admin*", "/login*"]) {
      expect(cspOf(rule)).toContain("frame-ancestors 'self'");
    }
  });
});
