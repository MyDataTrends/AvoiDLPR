import type { CameraDTO, SiteDTO } from "./protocol.ts";

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function compass(deg: number): string {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** Miles and feet where people drive by them (the US, Liberia, Myanmar), else kilometres and metres. */
export const IMPERIAL = (() => {
  try {
    return ["US", "LR", "MM"].includes(new Intl.Locale(navigator.language).maximize().region ?? "US");
  } catch {
    return true;
  }
})();

const FT_PER_M = 3.28084;
const M_PER_MI = 1609.344;

export function distance(m: number): string {
  if (IMPERIAL) {
    if (m < 0.1 * M_PER_MI) return `${Math.max(50, Math.round((m * FT_PER_M) / 50) * 50).toLocaleString("en-US")} ft`;
    const mi = m / M_PER_MI;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString("en-US")} mi`;
  }
  return m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
}

/**
 * A distance to say out loud, rounded the way people say them: "500 feet", "a quarter mile",
 * "1.5 miles"; "300 meters", "2 kilometers".
 */
export function spokenDistance(m: number): string {
  if (IMPERIAL) {
    const mi = m / M_PER_MI;
    if (mi < 0.2) return `${Math.max(100, Math.round((m * FT_PER_M) / 100) * 100)} feet`;
    if (mi < 0.375) return "a quarter mile";
    if (mi < 0.625) return "half a mile";
    if (mi < 0.875) return "three quarters of a mile";
    if (mi < 1.25) return "1 mile";
    return `${Math.round(mi * 2) / 2} miles`;
  }
  if (m < 1000) return `${Math.max(50, Math.round(m / 50) * 50)} meters`;
  const km = Math.round(m / 500) / 2;
  return `${km} kilometer${km === 1 ? "" : "s"}`;
}

/** A GPS accuracy radius: "±80 ft" or "±25 m". */
export function accuracy(m: number): string {
  return IMPERIAL ? `±${Math.max(10, Math.round((m * FT_PER_M) / 10) * 10).toLocaleString("en-US")} ft` : `±${Math.round(m)} m`;
}

export function duration(s: number): string {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

export function signedPercent(x: number): string {
  const p = Math.round(x * 100);
  return `${p >= 0 ? "+" : "−"}${Math.abs(p)}%`;
}

/** "+3 min" for a route this much slower than the fastest; "+<1 min" when it's under 30 s. */
export function extraTime(extraS: number): string {
  const m = Math.round(extraS / 60);
  return m >= 1 ? `+${m} min` : "+<1 min";
}

/** "3 min" for a gap in time, or "under a minute". */
export function gapTime(s: number): string {
  const m = Math.round(s / 60);
  return m >= 1 ? `${m} min` : "under a minute";
}

export function cameraZones(n: number): string {
  return `${n} camera zone${n === 1 ? "" : "s"}`;
}

/** Cameras whose ring (where one may still see you) a route passes: "near 2 cameras", or "near 2 more". */
export function nearCameras(n: number, more = false): string {
  return more ? `near ${n} more` : `near ${n} camera${n === 1 ? "" : "s"}`;
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
