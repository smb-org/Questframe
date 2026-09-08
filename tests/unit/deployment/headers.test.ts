import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { publicOriginFor, renderHeaders } from "../../../scripts/lib/headers.mjs";

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

const source = readFileSync(path.join(process.cwd(), "public/_headers"), "utf8");
const rules = parseHeaders(source);

const linesOf = (rule: string): string[] => {
  const lines = rules.get(rule);
  expect(lines, `Regel ${rule} fehlt in public/_headers`).toBeDefined();
  return lines ?? [];
};

const cspOf = (rule: string): string => {
  const csp = linesOf(rule).find((line) =>
    line.toLowerCase().startsWith("content-security-policy:"));
  expect(csp, `Regel ${rule} hat keine CSP`).toBeDefined();
  return csp ?? "";
};

describe("public/_headers", () => {
  it("hält frame-ancestors aus dem Catch-all heraus", () => {
    expect(cspOf("/*")).not.toContain("frame-ancestors");
  });

  it("setzt für die Overlay-Regeln gar kein frame-ancestors", () => {
    // Ein "frame-ancestors *" wäre hier falsch: "*" deckt laut CSP-Spec nur
    // Netzwerk-Schemata ab und schließt den opaken Origin des sandboxed
    // StreamElements-Widgets aus. Nur das Weglassen erlaubt jeden Einbetter.
    for (const rule of ["/overlay", "/overlay/*"]) {
      expect(cspOf(rule)).not.toContain("frame-ancestors");
    }
  });

  it("nutzt keinen Prefix-Glob, der Nicht-Overlay-Pfade einbettbar macht", () => {
    // "/overlay*" träfe auch "/overlay-x", und das rendert per SPA-Fallback die Admin-App.
    expect([...rules.keys()]).not.toContain("/overlay*");
  });

  it("verbietet Framing für die authentifizierten Oberflächen", () => {
    for (const rule of ["/admin*", "/login*"]) {
      expect(cspOf(rule)).toContain("frame-ancestors __PUBLIC_ORIGIN__");
    }
  });

  it("benutzt in keiner CSP mehr 'self'", () => {
    // 'self' matcht im opaken Origin des Widget-iframes auf nichts; der
    // ausgeschriebene Origin ist bei normalem Aufruf exakt gleich streng.
    // Nur die Direktiven prüfen — in den Kommentaren darf 'self' vorkommen.
    for (const rule of rules.keys()) {
      const lines = linesOf(rule).filter((line) =>
        line.toLowerCase().startsWith("content-security-policy:"));
      expect(lines.join("\n"), `Regel ${rule}`).not.toContain("'self'");
    }
  });

  it("gibt CORS nur für die gebauten Artefakte frei", () => {
    for (const rule of ["/_app/*", "/fonts/*"]) {
      expect(linesOf(rule)).toContain("Access-Control-Allow-Origin: *");
    }
    for (const rule of ["/admin*", "/login*", "/overlay", "/overlay/*", "/*"]) {
      expect(linesOf(rule).join("\n")).not.toContain("Access-Control-Allow-Origin");
    }
  });
});

describe("scripts/render-headers.mjs", () => {
  it("leitet Origin und Host aus PUBLIC_ORIGIN ab", () => {
    expect(publicOriginFor("staging", "https://hud.example.invalid/")).toEqual({
      origin: "https://hud.example.invalid",
      host: "hud.example.invalid",
    });
    expect(publicOriginFor("production", "https://hud.example.invalid")).toEqual({
      origin: "https://hud.example.invalid",
      host: "hud.example.invalid",
    });
  });

  it("fällt ohne Umgebung auf den lokalen Origin zurück", () => {
    expect(publicOriginFor(undefined, undefined).host).toBe("localhost:5173");
  });

  it("scheitert ohne PUBLIC_ORIGIN oder bei einer unsicheren URL", () => {
    expect(() => publicOriginFor("staging", undefined)).toThrow(/PUBLIC_ORIGIN/);
    expect(() => publicOriginFor("staging", "http://hud.example.invalid")).toThrow(/HTTPS/);
  });

  it("ersetzt beide Platzhalter in der echten Datei", () => {
    const rendered = renderHeaders(source, publicOriginFor("production", "https://hud.example.invalid"));
    expect(rendered).toContain("https://hud.example.invalid");
    expect(rendered).toContain("wss://hud.example.invalid");
    expect(rendered).not.toContain("__PUBLIC_");
  });

  it("scheitert bei einem übrig gebliebenen Platzhalter", () => {
    expect(() => renderHeaders("Content-Security-Policy: __PUBLIC_UNKNOWN__", {
      origin: "https://hud.example.invalid",
      host: "hud.example.invalid",
    })).toThrow(/Platzhalter/);
  });
});
