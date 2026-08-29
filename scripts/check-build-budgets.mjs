import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const projectRoot = path.resolve(import.meta.dirname, "..");
const clientRoot = path.join(projectRoot, "dist/client");
const manifest = JSON.parse(
  await readFile(path.join(clientRoot, ".vite/manifest.json"), "utf8"),
);

const kibibytes = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`;
const compressedSize = async (relative) =>
  gzipSync(await readFile(path.join(clientRoot, relative)), { level: 9 }).byteLength;

const collectStaticClosure = (entryKeys) => {
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    const entry = manifest[key];
    if (entry === undefined) throw new Error(`Build manifest entry is missing: ${key}`);
    visited.add(key);
    for (const imported of entry.imports ?? []) visit(imported);
  };
  for (const key of entryKeys) visit(key);
  return visited;
};

const sumJavaScript = async (closure) => {
  const files = [...closure]
    .map((key) => manifest[key].file)
    .filter((file) => file.endsWith(".js"));
  return (await Promise.all(files.map(compressedSize))).reduce((total, size) => total + size, 0);
};

const sumCss = async (closure) => {
  const files = new Set(
    [...closure].flatMap((key) => manifest[key].css ?? []),
  );
  return (await Promise.all([...files].map(compressedSize))).reduce((total, size) => total + size, 0);
};

const assertBudget = (label, actual, maximum) => {
  const marker = actual <= maximum ? "PASS" : "FAIL";
  console.log(`${marker.padEnd(4)} ${label.padEnd(34)} ${kibibytes(actual).padStart(12)} / ${kibibytes(maximum)}`);
  if (actual > maximum) throw new Error(`${label} exceeds its build budget.`);
};

const indexKey = "index.html";
const overlayKey = "src/overlay/OverlayApp.tsx";
const adminKey = "src/admin/AdminApp.tsx";
const temporalKey = "node_modules/@js-temporal/polyfill/dist/index.esm.js";
const overlayClosure = collectStaticClosure([indexKey, overlayKey]);
const adminClosure = collectStaticClosure([indexKey, adminKey]);
const temporalClosure = collectStaticClosure([temporalKey]);

if (overlayClosure.has(adminKey) || overlayClosure.has(temporalKey)) {
  throw new Error("Overlay initial code must not import Admin or Temporal modules.");
}
if (adminClosure.has(temporalKey)) {
  throw new Error("Temporal must remain lazy and outside the Admin initial closure.");
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

const overlayJavascript = await sumJavaScript(overlayClosure);
const adminJavascript = await sumJavaScript(adminClosure);
const temporalJavascript = await sumJavaScript(temporalClosure);
const shellBytes = await compressedSize("index.html");
const overlayCss = await sumCss(overlayClosure);
const adminCss = await sumCss(adminClosure);

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

const overlayTransfer = overlayJavascript + overlayCss + shellBytes + commonHudMedia + largestEightEffectBytes + fontBytes;
const adminTransfer = adminJavascript + adminCss + shellBytes + commonHudMedia + fontBytes;

console.log("Build budget report (gzip for text, encoded bytes for WebP)");
assertBudget("Worker bundle", workerBytes, 750 * 1024);
assertBudget("Overlay initial JavaScript", overlayJavascript, 120 * 1024);
assertBudget("Overlay initial static transfer", overlayTransfer, 1024 * 1024);
assertBudget("Admin initial JavaScript", adminJavascript, 250 * 1024);
assertBudget("Admin initial static transfer", adminTransfer, 1.5 * 1024 * 1024);
assertBudget("Lazy Temporal chunk", temporalJavascript, 100 * 1024);
