// Where the app's data lives, and what it says it has.
//
// The release (pipeline/release.py) is a plain directory of files: regions.json, packs/,
// cameras/ and basemap/. In dev and on `npm run phone` this site serves it itself; in
// production it is object storage, named by VITE_DATA_BASE at build time. Everything else
// is resolved from the manifest, so adding a city is a data change, not a code change.

/** The base URL data is fetched from, always absolute and ending in "/". */
const RAW_BASE = (import.meta.env.VITE_DATA_BASE ?? "").trim();
export const DATA_BASE: string = new URL(RAW_BASE === "" ? "/" : RAW_BASE.replace(/\/*$/, "/"), location.origin).href;

/**
 * Absolute URL of a path in the release (e.g. "packs/dallas.44e2.fwr"). Plain concatenation, not
 * `new URL`, because MapLibre's glyph template contains literal {fontstack}/{range} placeholders
 * that URL parsing would percent-encode.
 */
export function dataUrl(path: string): string {
  return DATA_BASE + path.replace(/^\/+/, "");
}

export interface RegionEntry {
  id: string;
  name: string;
  /** west, south, east, north */
  bbox: [number, number, number, number];
  center: [number, number];
  pack: { path: string; bytes: number; sha256: string; built_at: string };
  basemap: { path: string; bytes: number; sha256: string };
  cameras: { path: string };
  /** A trip worth showing off, if the region defines one. */
  example?: { from: [number, number]; to: [number, number] };
}

export interface Manifest {
  schema: number;
  generated_at: string;
  assets: { glyphs: string; sprite: string };
  regions: RegionEntry[];
}

const SUPPORTED_SCHEMA = 1;

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(dataUrl("regions.json"), { cache: "no-cache" });
  if (!res.ok) {
    const hint = import.meta.env.DEV ? " Stage the data with `python -m pipeline.release`." : "";
    throw new Error(`The map data index couldn't be loaded (HTTP ${res.status}).${hint}`);
  }
  const manifest = (await res.json()) as Manifest;
  if (manifest.schema !== SUPPORTED_SCHEMA) {
    throw new Error("The map data is newer than this app. Reload the page to update.");
  }
  if (!manifest.regions?.length) throw new Error("The map data lists no regions.");
  return manifest;
}

/** `?r=` / `#r=` names a region; otherwise the first one. */
export function pickRegion(manifest: Manifest, wanted: string | null): RegionEntry {
  return manifest.regions.find((r) => r.id === wanted) ?? manifest.regions[0];
}

export function regionContaining(manifest: Manifest, lon: number, lat: number): RegionEntry | null {
  return manifest.regions.find((r) => lon >= r.bbox[0] && lon <= r.bbox[2] && lat >= r.bbox[1] && lat <= r.bbox[3]) ?? null;
}
