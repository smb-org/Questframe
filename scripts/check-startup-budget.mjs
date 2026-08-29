import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const profilePath = path.join(tmpdir(), `irl-stream-hud-worker-startup-${String(process.pid)}.cpuprofile`);
const wranglerPath = path.resolve(
  import.meta.dirname,
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);

const result = spawnSync(
  wranglerPath,
  ["check", "startup", "--outfile", profilePath],
  {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: ".wrangler/logs/wrangler.log",
    },
    encoding: "utf8",
  },
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);
await unlink(profilePath).catch(() => undefined);

if (result.status !== 0) process.exit(result.status ?? 1);

const profileWindow = /Profile window:\s+([\d.]+)\s*ms/u.exec(output);
if (profileWindow === null) throw new Error("Wrangler startup profile did not report a profile window.");

const milliseconds = Number(profileWindow[1]);
const maximum = 100;
const marker = milliseconds <= maximum ? "PASS" : "FAIL";
console.log(`${marker} Worker startup ${milliseconds.toFixed(1)} ms / ${String(maximum)} ms`);
if (milliseconds > maximum) throw new Error("Worker startup exceeds its 100 ms budget.");
