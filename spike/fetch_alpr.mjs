// Data spike: pull ALPR nodes from OSM via Overpass (tiled bbox queries) and save one merged dump.
// Uses curl because Node's fetch hit connect timeouts to Overpass on this machine.
// Usage: node fetch_alpr.mjs [out.json]   (default alpr_US.json)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir, readFile, access } from "node:fs/promises";

const sh = promisify(execFile);
const out = process.argv[2] ?? "alpr_US.json";
// Fresh-data endpoints only (overpass.kumi.systems lagged months behind when tested).
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const STEP = 5; // degrees per tile
// Contiguous US (+ a bit of margin); AK/HI handled by extra tiles below.
const BOUNDS = { s: 24, n: 50, w: -125, e: -66 };
const EXTRA = [
  { s: 51, n: 72, w: -170, e: -129 }, // Alaska
  { s: 18, n: 23, w: -161, e: -154 }, // Hawaii
];

const tiles = [];
for (let s = BOUNDS.s; s < BOUNDS.n; s += STEP)
  for (let w = BOUNDS.w; w < BOUNDS.e; w += STEP)
    tiles.push({ s, n: Math.min(s + STEP, BOUNDS.n), w, e: Math.min(w + STEP, BOUNDS.e) });
tiles.push(...EXTRA);

await mkdir("tiles", { recursive: true });

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function fetchTile(t, idx) {
  const file = `tiles/t${idx}.json`;
  if (await exists(file)) return JSON.parse(await readFile(file, "utf8"));
  const q = `[out:json][timeout:120];node["surveillance:type"="ALPR"](${t.s},${t.w},${t.n},${t.e});out meta;`;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const qfile = `tiles/q${idx}.txt`;
      await writeFile(qfile, q);
      const { stdout } = await sh("curl.exe", [
        "-s", "-m", "150", "-A", "flockwatch-spike/0.1",
        "--data-urlencode", `data@${qfile}`, ENDPOINTS[(idx + attempt) % ENDPOINTS.length],
      ], { maxBuffer: 256 * 1024 * 1024 });
      if (stdout.startsWith("{") && !stdout.includes('"remark"')) {
        await writeFile(file, stdout);
        return JSON.parse(stdout);
      }
      const msg = stdout.match(/<strong[^>]*>Error<\/strong>:([^<]*)/)?.[1]?.trim() ?? stdout.slice(0, 120);
      const remark = stdout.match(/"remark":\s*"([^"]*)"/)?.[1];
      console.warn(`  tile ${idx} attempt ${attempt}: ${remark ?? msg}`);
    } catch (e) {
      console.warn(`  tile ${idx} attempt ${attempt}: ${e.message.slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
  throw new Error(`tile ${idx} failed`);
}

const byId = new Map();
for (const [i, t] of tiles.entries()) {
  const d = await fetchTile(t, i);
  for (const e of d.elements) byId.set(e.id, e);
  console.log(`tile ${i + 1}/${tiles.length} [${t.s},${t.w}..${t.n},${t.e}] +${d.elements.length} (total ${byId.size})`);
  await new Promise((r) => setTimeout(r, 1000));
}
await writeFile(out, JSON.stringify({ elements: [...byId.values()] }));
console.log(`saved ${out} elements=${byId.size}`);
