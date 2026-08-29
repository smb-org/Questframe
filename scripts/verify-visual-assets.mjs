import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const projectRoot = path.resolve(import.meta.dirname, "..");
const effectDirectory = path.join(projectRoot, "public/assets/effects");
const catalogSource = await import(path.join(projectRoot, "src/shared/domain/effects.ts"));
const expectedEffects = new Set(catalogSource.EFFECT_CATALOG.map((effect) => `${effect.iconId}.webp`));
const actualEffects = new Set((await readdir(effectDirectory)).filter((name) => name.endsWith(".webp")));

const missing = [...expectedEffects].filter((name) => !actualEffects.has(name));
const unexpected = [...actualEffects].filter((name) => !expectedEffects.has(name));
if (missing.length > 0 || unexpected.length > 0) {
  throw new Error(`Effect asset mismatch. Missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`);
}

for (const filename of expectedEffects) {
  const file = path.join(effectDirectory, filename);
  const [metadata, fileStat] = await Promise.all([sharp(file).metadata(), stat(file)]);
  if (metadata.format !== "webp" || metadata.width !== 128 || metadata.height !== 128) {
    throw new Error(`${filename} must be a 128×128 WebP.`);
  }
  if (metadata.hasAlpha) throw new Error(`${filename} unexpectedly contains an alpha channel.`);
  if (fileStat.size > 32 * 1024) throw new Error(`${filename} exceeds the 32 KiB icon budget.`);
}

const manifest = JSON.parse(
  await readFile(path.join(projectRoot, "src/assets/provenance/variants.json"), "utf8"),
);
const themeRoot = path.join(projectRoot, "public/assets/themes");

const actualVariants = new Set(
  (await readdir(themeRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
);
const variantNames = Object.keys(manifest.variants);
const unexpectedVariants = [...actualVariants].filter((name) => !variantNames.includes(name));
if (unexpectedVariants.length > 0) {
  throw new Error(`Unexpected theme directories: ${unexpectedVariants.join(", ")}`);
}

let checkedParts = 0;
for (const [variant, widths] of Object.entries(manifest.variants)) {
  const files = new Set(await readdir(path.join(themeRoot, variant)));
  const expected = new Set(Object.keys(manifest.parts).map((part) => `${part}.webp`));
  const missing = [...expected].filter((name) => !files.has(name));
  const unexpected = [...files].filter((name) => !expected.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${variant} asset mismatch. Missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`,
    );
  }

  for (const [part, spec] of Object.entries(manifest.parts)) {
    const file = path.join(themeRoot, variant, `${part}.webp`);
    const [metadata, fileStat] = await Promise.all([sharp(file).metadata(), stat(file)]);
    if (
      metadata.format !== "webp" ||
      metadata.width !== widths[part] ||
      metadata.height !== spec.height
    ) {
      throw new Error(
        `${variant}/${part} must be a ${String(widths[part])}×${String(spec.height)} WebP.`,
      );
    }
    if (!metadata.hasAlpha) throw new Error(`${variant}/${part} must keep its alpha channel.`);
    if (fileStat.size > spec.maxBytes) {
      throw new Error(`${variant}/${part} exceeds its ${String(spec.maxBytes)} byte budget.`);
    }
    checkedParts += 1;
  }
}

console.log(
  `Verified ${String(expectedEffects.size)} effect icons and ${String(checkedParts)} variant frame parts across ${String(variantNames.length)} variants.`,
);
