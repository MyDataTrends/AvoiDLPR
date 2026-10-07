// Where the app's data lives, and what it says it has.
//
// The release (pipeline/release.py) is a plain directory of files: regions.json, packs/,
// places/, cameras/ and basemap/. In dev and on `npm run phone` this site serves it itself; in
// production it is object storage, named by VITE_DATA_BASE at build time. Everything else
// is resolved from the manifest, so adding a city is a data change, not a code change.

/** The base URL data is fetched from, always absolute and ending in "/". */
const RAW_BASE = (import.meta.env.VITE_DATA_BASE ?? "").trim();
export const DATA_BASE: string = new URL(RAW_BASE === "" ? "/" : RAW_BASE.replace(/\/*$/, "/"), location.origin).href;

/**
 * Absolute URL of a path in the release (e.g. "packs/dallas.44e2.fwr.gz"). Plain concatenation,
 * not `new URL`, because MapLibre's glyph template contains literal {fontstack}/{range}
 * placeholders that URL parsing would percent-encode.
 */
export function dataUrl(path: string): string {
  return DATA_BASE + path.replace(/^\/+/, "");
}

export interface RegionEntry {
  id: string;
  name: string;
  /** What the area is filed under in the chooser: its home state ("North Carolina"). */
  group: string;
  /** Postal codes of the states it spans, home state first (["NC", "SC"]). */
  states: string[];
  /** west, south, east, north */
  bbox: [number, number, number, number];
  center: [number, number];
  pack: { path: string; encoding?: "gzip"; bytes: number; raw_bytes?: number; sha256: string; built_at: string; edges?: number };
  basemap: { path: string; bytes: number; sha256: string; maxzoom?: number | null };
  cameras: { path: string };
  /** The search index (pipeline/places.py); an area built before search existed has none. */
  places?: {
    path: string; encoding?: "gzip"; bytes: number; raw_bytes?: number; sha256: string; built_at: string;
    counts?: { streets: number; addresses: number; places: number };
  };
  /** A trip worth showing off, if the region defines one. */
  example?: { from: [number, number]; to: [number, number] };
}

export interface Manifest {
  schema: number;
  generated_at: string;
  /** `sprite_dark`: the dark map's icons, in releases made since dark mode. */
  assets: { glyphs: string; sprite: string; sprite_dark?: string };
  regions: RegionEntry[];
}

const SUPPORTED_SCHEMA = 2;

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(dataUrl("regions.json"), { cache: "no-cache" });
  if (!res.ok) {
    const hint = import.meta.env.DEV ? " Stage the data with `python -m pipeline.release`." : "";
    throw new Error(`The map data index couldn't be loaded (HTTP ${res.status}).${hint}`);
  }
  const manifest = (await res.json()) as Manifest;
  if (manifest.schema > SUPPORTED_SCHEMA) {
    throw new Error("The map data is newer than this app. Reload the page to update.");
  }
  if (manifest.schema < SUPPORTED_SCHEMA) {
    const hint = import.meta.env.DEV ? " Re-stage it with `python -m pipeline.release`." : "";
    throw new Error(`The map data is in an older format than this app reads.${hint}`);
  }
  if (!manifest.regions?.length) throw new Error("The map data lists no regions.");
  return manifest;
}

// ---------- which area to open ----------

const REMEMBER_KEY = "avoidlpr.region";

/** The area picked last time, if the browser lets us remember (on this device only). */
export function rememberedRegion(): string | null {
  try {
    return localStorage.getItem(REMEMBER_KEY);
  } catch {
    return null;
  }
}

export function rememberRegion(id: string): void {
  try {
    localStorage.setItem(REMEMBER_KEY, id);
  } catch {
    /* private mode or storage blocked: the chooser just asks again next time */
  }
}

/** `#r=` (or `?r=`) names an area, as a shared link or the app itself does. */
export function regionFromUrl(): string | null {
  return new URLSearchParams(location.hash.slice(1)).get("r") ?? new URLSearchParams(location.search).get("r");
}

/** The area to open: the link's, else the remembered one, else the only one; null means ask. */
export function initialRegion(manifest: Manifest): RegionEntry | null {
  for (const id of [regionFromUrl(), rememberedRegion()]) {
    const found = manifest.regions.find((r) => r.id === id);
    if (found) return found;
  }
  return manifest.regions.length === 1 ? manifest.regions[0] : null;
}

export function inBbox(bbox: readonly [number, number, number, number], lon: number, lat: number): boolean {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

/** Kilometres from a point to the nearest edge of a box it's inside (how much room it has). */
function marginKm(r: RegionEntry, lon: number, lat: number): number {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const [w, s, e, n] = r.bbox;
  return Math.min((lon - w) * kx, (e - lon) * kx, (lat - s) * 111.32, (n - lat) * 111.32);
}

/**
 * Areas that contain every given point, best first. Areas overlap at their edges (Dallas and Fort
 * Worth share Irving), so the best is the one the points sit deepest inside.
 */
export function regionsContaining(manifest: Manifest, ...points: [number, number][]): RegionEntry[] {
  return manifest.regions
    .filter((r) => points.every(([lon, lat]) => inBbox(r.bbox, lon, lat)))
    .map((r) => ({ r, room: Math.min(...points.map(([lon, lat]) => marginKm(r, lon, lat))) }))
    .sort((a, b) => b.room - a.room)
    .map(({ r }) => r);
}

/** Straight-line kilometres from a point to an area's centre. */
export function kmTo(r: RegionEntry, lon: number, lat: number): number {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  return Math.hypot((r.center[0] - lon) * kx, (r.center[1] - lat) * 111.32);
}

/** "Charlotte, NC" or "Charlotte, NC–SC". */
export function regionLabel(r: RegionEntry): string {
  return r.states.length ? `${r.name}, ${r.states.join("–")}` : r.name;
}
