// Fetch a region's self-hosted basemap: a Protomaps extract covering its road pack, plus the
// label fonts and icon sprites the style uses. After this, the app makes no third-party
// requests at all.
//
//   npm run fetch-basemap -w @flockwatch/web [-- --region dallas] [-- --build 20261002] [-- --force]
//   npm run fetch-basemap -w @flockwatch/web -- --assets-only      # just the fonts and sprites
//
// Needs the region's road pack at data/packs/<region>.fwr (its bounding box sets the extract),
// the pmtiles CLI (https://github.com/protomaps/go-pmtiles) on PATH or unzipped into
// tools/pmtiles/, and curl. `--build` defaults to the newest planet build listed at
// https://build-metadata.protomaps.dev/builds.json. Writes data/basemap/<region>.pmtiles.
//
// Extracts go to zoom 15, the most detailed level. One that would be bigger than --max-mb
// (default 150) drops to zoom 14, about 60% smaller; the map then overzooms, with less detail at
// street level. That keeps the whole country inside the storage free tier.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync } from "node:fs";
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
const PAD_DEG = 0.02;

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const force = process.argv.includes("--force");
const assetsOnly = process.argv.includes("--assets-only");
const MAX_MB = Number(arg("--max-mb") ?? 150);

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
const archive = join(OUT, `${REGION}.pmtiles`);

if (!assetsOnly && (!existsSync(archive) || force)) {
  mkdirSync(OUT, { recursive: true });
  const [w, s, e, n] = packBbox();
  const bbox = [w - PAD_DEG, s - PAD_DEG, e + PAD_DEG, n + PAD_DEG].map((v) => v.toFixed(4)).join(",");
  const build = arg("--build") ?? latestBuild();
  const source = `https://build.protomaps.com/${build}.pmtiles`;
  // Written beside the target and renamed over it, so a staged release that hard-links the old
  // file (pipeline/release.py) keeps its bytes.
  const partial = `${archive}.partial`;
  let chosen = null;
  for (const zoom of [15, 14]) {
    const extract = ["extract", source, partial, `--bbox=${bbox}`, `--maxzoom=${zoom}`];
    const dry = run(pmtiles, [...extract, "--dry-run"]);
    const mb = Number(/archive size of ([\d.]+) MB/.exec(dry)?.[1]);
    if (!(mb > 0)) throw new Error(`could not read the extract size from:\n${dry}`);
    if (mb <= MAX_MB) {
      chosen = { extract, mb, zoom };
      break;
    }
    console.log(`zoom ${zoom} would be ${mb} MB, over the ${MAX_MB} MB cap`);
  }
  if (!chosen) throw new Error(`even a zoom-14 extract is over ${MAX_MB} MB; shrink the region`);
  console.log(`extracting ${chosen.mb} MB (zoom ${chosen.zoom}) of ${source} for bbox ${bbox}`);
  rmSync(partial, { force: true });
  run(pmtiles, chosen.extract);
  renameSync(partial, archive);
}
for (const font of FONTS) {
  for (const range of GLYPH_RANGES) {
    download(`${ASSETS_URL}/fonts/${encodeURIComponent(font)}/${range}.pbf`, join(OUT, "assets", "fonts", font, `${range}.pbf`));
  }
}
for (const sprite of SPRITES) download(`${ASSETS_URL}/sprites/v4/${sprite}`, join(OUT, "assets", "sprites", "v4", sprite));
console.log(`basemap ready in ${OUT}`);
