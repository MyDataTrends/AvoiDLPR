import type { CameraDTO, SiteDTO } from "./protocol.ts";

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function compass(deg: number): string {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

export function distance(m: number): string {
  return m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
}

export function duration(s: number): string {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

export function signedPercent(x: number): string {
  const p = Math.round(x * 100);
  return `${p >= 0 ? "+" : "−"}${Math.abs(p)}%`;
}

/** What a camera watches, in words: Flock reads rear plates of one travel direction. */
export function watches(c: CameraDTO): string {
  if (c.mode === "any") return "direction unknown";
  const dirs = c.sectors.map(([b]) => compass(b));
  if (c.mode === "rear") return `reads plates heading ${dirs.join(" & ")}`;
  return `reads plates along ${c.sectors.map(([b]) => `${compass(b)}–${compass(b + 180)}`).join(" & ")}`;
}

export function siteTitle(site: SiteDTO): string {
  const brands = [...new Set(site.cameras.map((c) => c.brand || "Unknown brand"))];
  const n = site.cameras.length;
  return `${brands.join(", ")}${n > 1 ? ` · ${n} cameras` : ""}`;
}
