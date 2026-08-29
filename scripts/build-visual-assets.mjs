import { mkdir } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(projectRoot, "src/assets/provenance");
const effectOutput = path.join(projectRoot, "public/assets/effects");

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
await mkdir(path.join(projectRoot, "public/assets/themes"), { recursive: true });

await cropAtlas(path.join(sourceRoot, "muapi/buff-atlas-master.jpg"), buffIds);
await cropAtlas(path.join(sourceRoot, "muapi/debuff-atlas-master.jpg"), debuffIds);

await sharp(path.join(sourceRoot, "muapi/classic-remix-master.jpg"))
  .resize(960, 540, { fit: "cover" })
  .webp({ quality: 80, effort: 6 })
  .toFile(path.join(projectRoot, "public/assets/themes/classic-remix-surface.webp"));

console.log(`Built ${String(buffIds.length + debuffIds.length)} effect icons and 1 HUD asset.`);
