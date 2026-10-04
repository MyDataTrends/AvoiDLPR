// Fetch a region's self-hosted basemap: a Protomaps extract covering its road pack, plus the
// label fonts and icon sprites the style uses. After this, the app makes no third-party
// requests at all.
//
//   npm run fetch-basemap -w @flockwatch/web [-- --region dallas] [-- --build 20261002] [-- --force]
//
// Needs the region's road pack at data/packs/<region>.fwr (its bounding box sets the extract),
// the pmtiles CLI (https://github.com/protomaps/go-pmtiles) on PATH or unzipped into
// tools/pmtiles/, and curl. `--build` defaults to the newest planet build listed at
// https://build-metadata.protomaps.dev/builds.json. Writes data/basemap/<region>.pmtiles.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REGION = (process.argv.includes("--region") ? process.argv[process.argv.indexOf("--region") + 1] : "dallas");
const PACK = join(ROOT, "data", "packs", `${REGION}.fwr`);
const OUT = join(ROOT, "data", "basemap");
const ASSETS_URL = "https://protomaps.github.io/basemaps-assets";
const FONTS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"];
const GLYPH_RANGES = ["0-255", "256-511", "8192-8447"]; // Latin, Latin extended, punctuation
const SPRITES = ["light.json", "light.png", "light@2x.json", "light@2x.png"];
const MAX_MB = 150;
const PAD_DEG = 0.02;

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const force = process.argv.includes("--force");

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.error ?? r.stderr}`);
  return `${r.stdout}${r.stderr}`;
}

/** The newest planet build key (e.g. "20261002.pmtiles") from Protomaps' build index. */
function latestBuild() {
  const builds = JSON.parse(run("curl", ["-sfL", "-m", "60", "https://build-metadata.protomaps.dev/builds.json"]));
  const newest = builds.map((b) => b.key).filter((k) => /^\d{8}\.pmtiles$/.test(k)).sort().at(-1);
  if (!newest) throw new Error("no planet builds found in the Protomaps build index");
  return newest.replace(/\.pmtiles$/, "");
}

function packBbox() {
  const fd = openSync(PACK, "r");
  const head = Buffer.alloc(12);
  readSync(fd, head, 0, 12, 0);
  const json = Buffer.alloc(head.readUInt32LE(8));
  readSync(fd, json, 0, json.length, 12);
  closeSync(fd);
  return JSON.parse(json.toString("utf8")).bbox;
}

function download(url, path) {
  if (existsSync(path) && !force) return;
  mkdirSync(dirname(path), { recursive: true });
  run("curl", ["-sfL", "-m", "120", "-o", path, url]);
}

const local = join(ROOT, "tools", "pmtiles", process.platform === "win32" ? "pmtiles.exe" : "pmtiles");
const pmtiles = existsSync(local) ? local : "pmtiles";
const [w, s, e, n] = packBbox();
const bbox = [w - PAD_DEG, s - PAD_DEG, e + PAD_DEG, n + PAD_DEG].map((v) => v.toFixed(4)).join(",");
const archive = join(OUT, `${REGION}.pmtiles`);

if (!existsSync(archive) || force) {
  mkdirSync(OUT, { recursive: true });
  const build = arg("--build") ?? latestBuild();
  const source = `https://build.protomaps.com/${build}.pmtiles`;
  const extract = ["extract", source, archive, `--bbox=${bbox}`, "--maxzoom=15"];
  const dry = run(pmtiles, [...extract, "--dry-run"]);
  const mb = Number(/archive size of ([\d.]+) MB/.exec(dry)?.[1]);
  if (!(mb > 0)) throw new Error(`could not read the extract size from:\n${dry}`);
  if (mb > MAX_MB) throw new Error(`extract would be ${mb} MB (cap ${MAX_MB} MB); shrink the bbox or maxzoom`);
  console.log(`extracting ${mb} MB of ${source} for bbox ${bbox}`);
  run(pmtiles, extract);
}
for (const font of FONTS) {
  for (const range of GLYPH_RANGES) {
    download(`${ASSETS_URL}/fonts/${encodeURIComponent(font)}/${range}.pbf`, join(OUT, "assets", "fonts", font, `${range}.pbf`));
  }
}
for (const sprite of SPRITES) download(`${ASSETS_URL}/sprites/v4/${sprite}`, join(OUT, "assets", "sprites", "v4", sprite));
console.log(`basemap ready in ${OUT}`);
