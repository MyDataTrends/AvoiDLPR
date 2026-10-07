/**
 * Camera capture-zone geometry: the one predicate shared by routing and live alerts.
 * Port of spike/routing/geometry.py; test/fixtures/reference_cases.json keeps them in lockstep.
 *
 * A camera is a set of sectors (apex = mapped pole, compass bearing, half-angle, range).
 * A vehicle at p with heading h is captured when p lies within `epsM` of a sector and h
 * satisfies the camera's heading mode:
 *   rear - travelling the way the camera faces (Flock: rear plates, one travel direction)
 *   axis - along the camera axis either way (front or rear plate)
 *   any  - heading ignored; used when direction is unknown, and the sector is a full disk
 * Coordinates are local metres (x east, y north); bearings are compass degrees
 * (0 = north, clockwise).
 */

export const EARTH_RADIUS_M = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export interface ZoneParams {
  /** R: how far ahead the camera reads plates. */
  rangeM: number;
  /** alpha (deg): half the field of view, padded for mapped-bearing error. */
  halfAngle: number;
  /** Tolerance for mapped vs. true pole position and the lane's offset from the centreline. */
  epsM: number;
  /** beta (deg): allowed deviation of vehicle heading from the camera axis. */
  headingTol: number;
}

/**
 * Flock's published spec: reads up to ~75 ft (23 m), field of view ~15-20 ft wide at 65 ft
 * (half-angle ~8-9 deg), one travel direction, rear plates. The profiles pad that for OSM
 * mapping error by increasing amounts; `default` is what the spike validated in Dallas.
 */
export const PROFILES = {
  strict: { rangeM: 25, halfAngle: 15, epsM: 8, headingTol: 30 },
  default: { rangeM: 50, halfAngle: 30, epsM: 12, headingTol: 45 },
  loose: { rangeM: 100, halfAngle: 45, epsM: 20, headingTol: 60 },
} as const satisfies Record<string, ZoneParams>;

/**
 * The ring round each zone where a camera may still see you: one profile up, and either way
 * along the camera's axis. It stands for what the zone leaves out. Flock's long-range,
 * wide-range and zoom (PTZ) cameras reach further than its standard one, with no published
 * range, and the map data doesn't say which a camera is; oncoming cars show their fronts (a
 * front plate in many states, and the make, model and colour Flock logs anyway); and mapping
 * error beyond the zone's own margin.
 */
export const RINGS = {
  strict: PROFILES.default,
  default: PROFILES.loose,
  loose: { rangeM: 150, halfAngle: 60, epsM: 25, headingTol: 75 },
} as const satisfies Record<keyof typeof PROFILES, ZoneParams>;

/** A ring's share of what a capture costs a route: a detour round one has to be nearly free. */
export const RING_WEIGHT = 0.25;

export type HeadingMode = "rear" | "axis" | "any";
/** [compass bearing, half-angle] in degrees. */
export type Sector = readonly [number, number];

export interface Camera {
  osmId: number;
  lon: number;
  lat: number;
  x: number;
  y: number;
  mode: HeadingMode;
  sectors: readonly Sector[];
  brand: string;
}

/** A camera as published by DeFlock (the CDN's region tiles use this shape). */
export interface CameraRecord {
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

/**
 * Equirectangular projection about (lat0, lon0). Scale error ~ tan(lat0) * dlat (rad):
 * about 0.2% across a metro, sub-millimetre across one camera zone.
 */
export class LocalProjection {
  readonly lat0: number;
  readonly lon0: number;
  readonly kx: number;
  readonly ky: number;

  constructor(lat0: number, lon0: number) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.ky = 1 * DEG_TO_RAD * EARTH_RADIUS_M;
    this.kx = this.ky * Math.cos(lat0 * DEG_TO_RAD);
  }

  x(lon: number): number {
    return (lon - this.lon0) * this.kx;
  }

  y(lat: number): number {
    return (lat - this.lat0) * this.ky;
  }

  lon(x: number): number {
    return x / this.kx + this.lon0;
  }

  lat(y: number): number {
    return y / this.ky + this.lat0;
  }
}

/** Wrap an angle to [-180, 180). */
export function wrap180(deg: number): number {
  const r = (deg + 180) % 360;
  return (r < 0 ? r + 360 : r) - 180;
}

function mod360(deg: number): number {
  const r = deg % 360;
  return r < 0 ? r + 360 : r === 0 ? 0 : r; // also folds -0 to 0
}

/** Compass bearing (deg, clockwise from north) of a displacement (east, north). */
export function compassBearing(dx: number, dy: number): number {
  return mod360(Math.atan2(dx, dy) * RAD_TO_DEG);
}

const COMPASS: Record<string, number> = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const RANGE = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/;

/**
 * OSM `direction` -> [centre bearing, extra half-width] per sector, or null when unusable.
 * Accepts numbers (negatives wrap: -30 -> 330), `a-b` ranges (the sector clockwise from a
 * to b), `;` lists and compass points. `forward`/`backward` depend on the host way, so they
 * count as unknown, as do magnitudes beyond 360.
 */
export function parseDirection(raw: string | null | undefined): Sector[] | null {
  if (raw === null || raw === undefined) return null;
  const out: Sector[] = [];
  for (const part of String(raw).split(";")) {
    const p = part.trim().toUpperCase();
    if (!p) continue;
    const range = RANGE.exec(p);
    if (NUMBER.test(p)) {
      const v = Number(p);
      if (v < -360 || v > 360) return null;
      out.push([mod360(v), 0]);
    } else if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a > 360 || b > 360) return null;
      const span = mod360(b - a);
      out.push([mod360(a + span / 2), span / 2]);
    } else if (Object.hasOwn(COMPASS, p)) {
      out.push([COMPASS[p], 0]);
    } else {
      return null;
    }
  }
  return out.length ? out : null;
}

/**
 * Exact Euclidean distance from a point (px, py), relative to the apex, to the sector
 * {d <= R, |angle off bearing| <= alpha}; zero inside. Inside the wedge the nearest sector
 * point is radial. Outside it the nearest point is on the closer edge ray (length R), at
 * angle phi = off-axis angle - alpha from p: project onto the ray and clamp to [0, R].
 */
export function sectorDistance(px: number, py: number, bearing: number, halfAngle: number, rangeM: number): number {
  const d = Math.hypot(px, py);
  const offAxis = Math.abs(wrap180(compassBearing(px, py) - bearing));
  if (offAxis <= halfAngle) return Math.max(d - rangeM, 0);
  const phi = Math.min(offAxis - halfAngle, 180) * DEG_TO_RAD;
  const s = d * Math.cos(phi);
  if (s <= 0) return d;
  if (s >= rangeM) return Math.sqrt(Math.max(d * d + rangeM * rangeM - 2 * d * rangeM * Math.cos(phi), 0));
  return d * Math.sin(phi);
}

export function headingMatches(heading: number, bearing: number, mode: HeadingMode, tol: number): boolean {
  if (mode === "any") return true;
  const off = Math.abs(wrap180(heading - bearing));
  if (mode === "rear") return off <= tol;
  return Math.min(off, 180 - off) <= tol;
}

/** Is a vehicle at (x, y) travelling on `heading` inside this camera's capture zone? */
export function captures(cam: Camera, x: number, y: number, heading: number, p: ZoneParams): boolean {
  const px = x - cam.x;
  const py = y - cam.y;
  for (const [bearing, halfAngle] of cam.sectors) {
    if (sectorDistance(px, py, bearing, halfAngle, p.rangeM) <= p.epsM
      && headingMatches(heading, bearing, cam.mode, p.headingTol)) return true;
  }
  return false;
}

/**
 * Flock is modelled rear-only per its spec; other brands' plate side is undocumented, so
 * they get both directions along the axis. `omni` drops heading entirely; `bothWays` gives
 * Flock both directions too (a ring: see RINGS).
 */
export function cameraFromRecord(rec: CameraRecord, proj: LocalProjection, p: ZoneParams, omni = false,
  bothWays = false): Camera {
  const tags = rec.tags ?? {};
  const brand = tags.manufacturer || tags.brand || "";
  const dirs = parseDirection(tags.direction || tags["camera:direction"]);
  const base = { osmId: rec.id, lon: rec.lon, lat: rec.lat, x: proj.x(rec.lon), y: proj.y(rec.lat), brand };
  if (!dirs) return { ...base, mode: "any", sectors: [[0, 180]] };
  const sectors = dirs.map(([b, extra]): Sector => [b, Math.min(180, p.halfAngle + extra)]);
  return { ...base, mode: omni ? "any" : brand.startsWith("Flock") && !bothWays ? "rear" : "axis", sectors };
}

/**
 * Length of a straight pass through the middle of the buffered zone: what counts as one full
 * exposure (sector: from eps behind the pole to R + eps ahead).
 */
export function zoneReferenceLength(cam: Camera, p: ZoneParams): number {
  return cam.sectors[0][1] >= 180 ? 2 * (p.rangeM + p.epsM) : p.rangeM + 2 * p.epsM;
}
