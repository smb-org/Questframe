import { readdir, stat } from "node:fs/promises";
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

const fixedAssets = [
  ["public/assets/themes/classic-remix-surface.webp", 960, 540, 180 * 1024],
];
for (const [relative, width, height, maximumBytes] of fixedAssets) {
  const file = path.join(projectRoot, relative);
  const [metadata, fileStat] = await Promise.all([sharp(file).metadata(), stat(file)]);
  if (metadata.format !== "webp" || metadata.width !== width || metadata.height !== height) {
    throw new Error(`${relative} has invalid dimensions or format.`);
  }
  if (fileStat.size > maximumBytes) throw new Error(`${relative} exceeds its asset budget.`);
}

console.log(`Verified ${String(expectedEffects.size)} effect icons and ${String(fixedAssets.length)} HUD assets.`);
