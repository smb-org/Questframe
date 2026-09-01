import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { sumDirectoryBytes } from "./lib/build-budget-assets.mjs";
import { assetSizeKey, collectStaticClosure, evaluateBuildBudgets } from "./lib/build-budgets.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const clientRoot = path.join(projectRoot, "dist/client");
const indexKey = "index.html";
const overlayKey = "src/overlay/OverlayApp.tsx";
const adminKey = "src/admin/AdminApp.tsx";
const challengeSourceKey = "src/challenges/ChallengeSourceApp.tsx";
const compositeKey = "src/composite/CompositeApp.tsx";
const liveKey = "src/live/LiveApp.tsx";
// pnpm verschachtelt den aufgeloesten Pfad unter node_modules/.pnpm/..., deshalb
// matchen wir weiterhin per Suffix statt gegen ein package-manager-spezifisches Layout.
const temporalKeySuffix = "@js-temporal/polyfill/dist/index.esm.js";
const qrCodeKeySuffix = "/qrcode/lib/browser.js";

const createBudgetDeclarations = (temporalKey, challengeThemeKeys, challengeStyleKeys, qrCodeKey) => [
  {
    type: "surface",
    key: overlayKey,
    label: "Overlay",
    staticRoots: [indexKey],
    javascriptLabel: "Overlay initial JavaScript",
    javascriptBudget: 120 * 1024,
    transferLabel: "Overlay initial static transfer",
    transferBudget: 1024 * 1024,
    transferAssets: ["shell", "font", "hudMedia", "effects", "audio"],
  },
  {
    type: "surface",
    key: adminKey,
    label: "Admin",
    staticRoots: [indexKey],
    javascriptLabel: "Admin initial JavaScript",
    javascriptBudget: 250 * 1024,
    transferLabel: "Admin initial static transfer",
    transferBudget: 1.5 * 1024 * 1024,
    transferAssets: ["shell", "font", "hudMedia"],
  },
  {
    type: "surface",
    key: temporalKey,
    label: "Temporal",
    javascriptLabel: "Lazy Temporal chunk",
    javascriptBudget: 100 * 1024,
  },
  {
    type: "surface",
    key: qrCodeKey,
    label: "QR-Code Chunk",
    javascriptLabel: "Dynamischer QR-Code-Einstiegspunkt",
    javascriptBudget: 32 * 1024,
  },
  {
    type: "surface",
    key: challengeSourceKey,
    label: "Challenge-Quelle",
    staticRoots: [indexKey],
    javascriptLabel: "Challenge-Quelle initial JavaScript",
    javascriptBudget: 80 * 1024,
    transferLabel: "Challenge-Quelle initial static transfer",
    transferBudget: 512 * 1024,
    transferAssets: ["shell", "font", "hudMedia", "effects", "audio"],
  },
  {
    type: "surface",
    key: compositeKey,
    label: "Composite-Quelle",
    staticRoots: [indexKey],
    javascriptLabel: "Composite-Quelle initial JavaScript",
    javascriptBudget: 100 * 1024,
    transferLabel: "Composite-Quelle initial static transfer",
    transferBudget: 350 * 1024,
    transferAssets: ["shell", "font", "hudMedia", "effects", "audio"],
  },
  {
    type: "surface",
    key: liveKey,
    label: "Live-Seite",
    staticRoots: [indexKey],
    javascriptLabel: "Live-Seite initial JavaScript",
    javascriptBudget: 200 * 1024,
    transferLabel: "Live-Seite initial static transfer",
    transferBudget: 1024 * 1024,
    transferAssets: ["shell", "font"],
  },
  {
    // Im laufenden Stream wird genau eine Theme-Variante geladen. Deshalb
    // zaehlt hier das groesste vollstaendige Theme-Chunk, nicht die Summe.
    type: "variantMax",
    label: "Challenge-Theme-Chunk (variantMax)",
    keys: challengeThemeKeys,
    budget: 64 * 1024,
  },
  {
    // Im laufenden Stream wird genau ein Aufbau geladen. Deshalb zaehlt hier
    // das groesste vollstaendige Style-Chunk, nicht die Summe.
    type: "variantMax",
    label: "Challenge-Style-Chunk (variantMax)",
    keys: challengeStyleKeys,
    budget: 64 * 1024,
  },
  {
    type: "exempt",
    key: indexKey,
    reason: "Die Shell fließt über staticRoots in jede Surface-Closure ein und steckt zusätzlich als Asset-Gruppe shell im Transfer.",
  },
];

const manifest = JSON.parse(
  await readFile(path.join(clientRoot, ".vite/manifest.json"), "utf8"),
);

const kibibytes = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`;
const compressedSize = async (relative) =>
  gzipSync(await readFile(path.join(clientRoot, relative)), { level: 9 }).byteLength;

const collectDynamicImports = (rootKey) => {
  const seen = new Set();
  const dynamicImports = new Set();
  const pending = [rootKey];
  while (pending.length > 0) {
    const key = pending.pop();
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    const entry = manifest[key];
    if (entry === undefined) continue;
    for (const dynamicKey of entry.dynamicImports ?? []) dynamicImports.add(dynamicKey);
    for (const importKey of entry.imports ?? []) pending.push(importKey);
  }
  return dynamicImports;
};

const temporalKeyCandidates = Object.keys(manifest).filter((key) => key.endsWith(temporalKeySuffix));
if (temporalKeyCandidates.length !== 1) {
  throw new Error(`Expected exactly one manifest entry ending in ${temporalKeySuffix}, found ${String(temporalKeyCandidates.length)}.`);
}
const [temporalKey] = temporalKeyCandidates;
const challengeSourceDynamicImports = collectDynamicImports(challengeSourceKey);
const challengeThemeKeys = [...challengeSourceDynamicImports].filter((key) => (
  manifest[key]?.name === "theme"
));
if (challengeThemeKeys.length !== 6) {
  throw new Error(`Expected six dynamic Challenge-Theme-Chunks, found ${String(challengeThemeKeys.length)}.`);
}
const challengeStyleKeys = [...challengeSourceDynamicImports].filter((key) => (
  manifest[key]?.src?.startsWith("src/modules/win-challenges/styles/") && manifest[key]?.isDynamicEntry === true
)) ?? [];
if (challengeStyleKeys.length !== 3) {
  throw new Error(`Expected three dynamic Challenge-Style-Chunks, found ${String(challengeStyleKeys.length)}.`);
}
const adminEntry = manifest[adminKey];
const qrCodeKeyCandidates = adminEntry?.dynamicImports?.filter((key) => key.endsWith(qrCodeKeySuffix)) ?? [];
if (qrCodeKeyCandidates.length !== 1) {
  throw new Error(`Expected exactly one dynamic QR-Code entry ending in ${qrCodeKeySuffix}, found ${String(qrCodeKeyCandidates.length)}.`);
}
const [qrCodeKey] = qrCodeKeyCandidates;
const sharedChallengeLoaderKeys = [
  "src/challenges/style-loader.ts",
  "src/challenges/theme-loader.ts",
].filter((key) => manifest[key] !== undefined);
const budgetDeclarations = [
  ...createBudgetDeclarations(temporalKey, challengeThemeKeys, challengeStyleKeys, qrCodeKey),
  ...sharedChallengeLoaderKeys.map((key) => ({
    type: "exempt",
    key,
    reason: "Der Loader ist ein kleiner geteilter Bruecken-Chunk; seine konkreten Style- und Theme-Varianten werden separat als variantMax gemessen.",
  })),
];

const overlayClosure = collectStaticClosure(manifest, [indexKey, overlayKey]);
const adminClosure = collectStaticClosure(manifest, [indexKey, adminKey]);
const compositeClosure = collectStaticClosure(manifest, [indexKey, compositeKey]);

if (overlayClosure.has(adminKey) || overlayClosure.has(temporalKey)) {
  throw new Error("Overlay initial code must not import Admin or Temporal modules.");
}
if (compositeClosure.has(adminKey) || compositeClosure.has(temporalKey)) {
  throw new Error("Composite initial code must not import Admin or Temporal modules.");
}
if (adminClosure.has(temporalKey) || adminClosure.has(qrCodeKey)) {
  throw new Error("Temporal und QR-Code müssen lazy und außerhalb der Admin-Initial-Closure bleiben.");
}

const distributionEntries = await readdir(path.join(projectRoot, "dist"), { withFileTypes: true });
const workerDirectories = distributionEntries
  .filter((entry) => entry.isDirectory() && entry.name !== "client")
  .map((entry) => entry.name);
if (workerDirectories.length !== 1) throw new Error("Expected exactly one built Worker directory.");
const workerBytes = gzipSync(
  await readFile(path.join(projectRoot, "dist", workerDirectories[0], "index.js")),
  { level: 9 },
).byteLength;

const effectDirectory = path.join(clientRoot, "assets/effects");
const largestEightEffectBytes = (
  await Promise.all(
    (await readdir(effectDirectory)).map(async (name) => (await stat(path.join(effectDirectory, name))).size),
  )
).sort((left, right) => right - left).slice(0, 8).reduce((total, size) => total + size, 0);
const themeRoot = path.join(clientRoot, "assets/themes");
// Es wird immer nur eine Variante gerendert, also zaehlt die groesste.
const variantSizes = await Promise.all(
  (await readdir(themeRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const files = await readdir(path.join(themeRoot, entry.name));
      const sizes = await Promise.all(
        files.map(async (name) => (await stat(path.join(themeRoot, entry.name, name))).size),
      );
      return sizes.reduce((total, size) => total + size, 0);
    }),
);
const commonHudMedia = Math.max(0, ...variantSizes);
const fontBytes = (await stat(
  path.join(clientRoot, "fonts/AtkinsonHyperlegibleNext-variable.woff2"),
)).size;

const soundDirectory = path.join(clientRoot, "assets/sounds");
const audioBytes = await sumDirectoryBytes(soundDirectory);
const audioBudget = 128 * 1024;

const assetSizes = new Map([
  [assetSizeKey("shell"), await compressedSize("index.html")],
  [assetSizeKey("font"), fontBytes],
  [assetSizeKey("hudMedia"), commonHudMedia],
  [assetSizeKey("effects"), largestEightEffectBytes],
  [assetSizeKey("audio"), audioBytes],
]);
const allowedAssetGroups = [...assetSizes.keys()]
  .map((key) => key.slice("asset:".length));
const sizeLookup = async (target) => {
  const assetSize = assetSizes.get(target);
  if (assetSize !== undefined) return assetSize;
  if (target.startsWith("asset:")) {
    const group = target.slice("asset:".length);
    throw new Error(
      `Unknown build budget asset group "${group}". Allowed groups: ${allowedAssetGroups.join(", ")}.`,
    );
  }
  return compressedSize(target);
};

const assertBudget = (label, actual, maximum) => {
  const marker = actual <= maximum ? "PASS" : "FAIL";
  console.log(`${marker.padEnd(4)} ${label.padEnd(34)} ${kibibytes(actual).padStart(12)} / ${kibibytes(maximum)}`);
  return actual <= maximum;
};

const report = await evaluateBuildBudgets(manifest, sizeLookup, budgetDeclarations);

console.log("Build budget report (gzip for text, encoded bytes for WebP)");
const workerWithinBudget = assertBudget("Worker bundle", workerBytes, 750 * 1024);
const audioWithinBudget = assertBudget("Audio total", audioBytes, audioBudget);
for (const check of report.checks) {
  if (check.status === "PEND") {
    console.log(`PEND ${check.label.padEnd(34)}`);
  } else {
    assertBudget(check.label, check.actual, check.maximum);
  }
}
const budgetErrors = report.checks
  .filter((check) => check.status === "FAIL")
  .map((check) => `${check.label} exceeds its build budget.`);
const errors = [
  ...(workerWithinBudget ? [] : ["Worker bundle exceeds its build budget."]),
  ...(audioWithinBudget ? [] : ["Audio total exceeds its build budget."]),
  ...report.errors,
  ...budgetErrors,
];
if (errors.length > 0) throw new Error(errors.join("\n"));
