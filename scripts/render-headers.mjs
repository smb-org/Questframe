// CLI zum Rendern von dist/client/_headers nach dem Vite-Build. Die Umgebung kommt
// als Argument, der öffentliche Origin aus PUBLIC_ORIGIN.
//
// Das Argument ist Absicht: cross-env setzt CLOUDFLARE_ENV nur für das umschlossene
// "vite build", nicht für nachfolgende &&-Kommandos. Über die Variable gelesen wäre
// hier still der lokale Fallback gelandet.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { publicOriginFor, renderHeaders } from "./lib/headers.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

const main = async () => {
  const environment = process.argv[2];
  const target = path.join(projectRoot, "dist/client/_headers");
  const rendered = renderHeaders(
    await readFile(target, "utf8"),
    publicOriginFor(environment, process.env.PUBLIC_ORIGIN),
  );
  await writeFile(target, rendered);
  console.log(`_headers gerendert für ${environment ?? "lokal"}.`);
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
