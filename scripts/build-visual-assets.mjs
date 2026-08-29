import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(projectRoot, "src/assets/provenance");
const effectOutput = path.join(projectRoot, "public/assets/effects");
const themeOutput = path.join(projectRoot, "public/assets/themes");

const buffIds = [
  "buff-gestaerkt",
  "buff-satt",
  "buff-ausgeruht",
  "buff-koffeinkick",
  "buff-rueckenwind",
  "buff-sonnenkind",
  "buff-wetterfest",
  "buff-fokussiert",
  "buff-crewpower",
  "buff-glueckspilz",
  "buff-pfadfinder",
  "buff-feuerwaerme",
  "buff-gipfelrausch",
  "buff-proviant",
  "buff-adrenalinschub",
  "buff-tatendrang",
  "buff-naturverbunden",
  "buff-streamsegen",
  "buff-heissgetraenk",
  "buff-entdeckergeist",
];

const debuffIds = [
  "debuff-hungrig",
  "debuff-muede",
  "debuff-durstig",
  "debuff-nasse-socken",
  "debuff-sonnenbrand",
  "debuff-muskelkater",
  "debuff-verlaufen",
  "debuff-funkloch",
  "debuff-gegenwind",
  "debuff-regenschauer",
  "debuff-blase-am-fuss",
  "debuff-schweres-gepaeck",
  "debuff-kaelteschock",
  "debuff-hitzestau",
  "debuff-matschig",
  "debuff-low-battery",
  "debuff-chat-vermisst",
  "debuff-umweg",
  "debuff-zeckenalarm",
  "debuff-pausenbedarf",
];

const cropAtlas = async (source, ids) => {
  const input = sharp(source);
  const metadata = await input.metadata();
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new Error(`Atlas dimensions are unavailable: ${source}`);
  }

  const cellWidth = metadata.width / 5;
  const cellHeight = metadata.height / 4;
  const cropSize = Math.floor(Math.min(cellWidth, cellHeight) * 0.96);

  await Promise.all(
    ids.map(async (id, index) => {
      const column = index % 5;
      const row = Math.floor(index / 5);
      const left = Math.round(column * cellWidth + (cellWidth - cropSize) / 2);
      const top = Math.round(row * cellHeight + (cellHeight - cropSize) / 2);
      await sharp(source)
        .extract({ left, top, width: cropSize, height: cropSize })
        .resize(128, 128, { fit: "cover" })
        .webp({ quality: 88, effort: 6 })
        .toFile(path.join(effectOutput, `${id}.webp`));
    }),
  );
};

await mkdir(effectOutput, { recursive: true });
await mkdir(themeOutput, { recursive: true });

await cropAtlas(path.join(sourceRoot, "muapi/buff-atlas-master.jpg"), buffIds);
await cropAtlas(path.join(sourceRoot, "muapi/debuff-atlas-master.jpg"), debuffIds);

const manifest = JSON.parse(await readFile(path.join(sourceRoot, "variants.json"), "utf8"));

// Die Master sind bereits freigestellte PNGs. Der Build trimmt nur den
// transparenten Rand weg und skaliert auf die im Manifest hinterlegte Zielbox,
// deren Breite dem Seitenverhaeltnis des Masters folgt.
const buildVariantPart = async (variant, part, spec, width) => {
  const master = path.join(sourceRoot, "muapi/masters", variant, spec.master);
  const target = path.join(themeOutput, variant, `${part}.webp`);
  await mkdir(path.dirname(target), { recursive: true });
  await sharp(master)
    .trim({ threshold: 1 })
    .resize(width, spec.height, { fit: "fill" })
    .webp({ quality: 86, alphaQuality: 100, effort: 6 })
    .toFile(target);
};

let variantParts = 0;
for (const [variant, widths] of Object.entries(manifest.variants)) {
  for (const [part, spec] of Object.entries(manifest.parts)) {
    await buildVariantPart(variant, part, spec, widths[part]);
    variantParts += 1;
  }
}

console.log(
  `Built ${String(buffIds.length + debuffIds.length)} effect icons and ${String(variantParts)} variant frame parts.`,
);
