"""Camera capture-zone geometry: the one predicate shared by routing and live alerts.

A camera is a set of sectors (apex = mapped pole position, compass bearing, half-angle,
range). A vehicle at position p with heading h is *captured* by a sector when p lies
within `eps_m` of the sector and h satisfies the camera's heading mode:

  rear  - travelling the way the camera faces (Flock: rear plates, one travel direction)
  axis  - travelling along the camera axis either way (front or rear plate)
  any   - heading ignored; used when direction is unknown, and the sector is a full disk

Coordinates are local metres (x east, y north) from `LocalProjection`; bearings are
compass degrees (0 = north, clockwise). Everything is vectorised over numpy arrays so the
same functions serve one GPS fix or millions of road samples.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

import numpy as np

EARTH_RADIUS_M = 6_371_008.8


@dataclass(frozen=True)
class ZoneParams:
    range_m: float  # R: how far ahead the camera reads plates
    half_angle: float  # alpha (deg): half the field of view, padded for mapped-bearing error
    eps_m: float  # tolerance: mapped vs. true pole position, lane offset from road centreline
    heading_tol: float  # beta (deg): allowed deviation of vehicle heading from the camera axis


# Flock's published spec: reads up to ~75 ft (23 m); field of view ~15-20 ft wide at 65 ft
# (half-angle ~8-9 deg); 1.5 lanes of one travel direction, rear plates. The profiles pad
# that for OSM mapping error (pole position, hand-estimated bearing) by increasing amounts.
PROFILES: dict[str, ZoneParams] = {
    "strict": ZoneParams(range_m=25, half_angle=15, eps_m=8, heading_tol=30),
    "default": ZoneParams(range_m=50, half_angle=30, eps_m=12, heading_tol=45),
    "loose": ZoneParams(range_m=100, half_angle=45, eps_m=20, heading_tol=60),
}

_COMPASS = {
    "N": 0.0, "NNE": 22.5, "NE": 45.0, "ENE": 67.5, "E": 90.0, "ESE": 112.5, "SE": 135.0,
    "SSE": 157.5, "S": 180.0, "SSW": 202.5, "SW": 225.0, "WSW": 247.5, "W": 270.0,
    "WNW": 292.5, "NW": 315.0, "NNW": 337.5,
}
_NUMBER = re.compile(r"^-?\d+(?:\.\d+)?$")
_RANGE = re.compile(r"^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$")


def parse_direction(raw: str | None) -> list[tuple[float, float]] | None:
    """OSM `direction` -> [(centre_bearing, extra_half_width)], or None when unusable.

    Accepts numbers (negatives wrap: -30 -> 330), `a-b` ranges (the sector clockwise from
    a to b), `;` lists and compass points. `forward`/`backward` depend on the host way, so
    they count as unknown, as do magnitudes beyond 360 (e.g. the `150000099` typo seen in data).
    """
    if raw is None:
        return None
    out: list[tuple[float, float]] = []
    for part in str(raw).split(";"):
        p = part.strip().upper()
        if not p:
            continue
        if _NUMBER.match(p):
            v = float(p)
            if not -360 <= v <= 360:
                return None
            out.append((v % 360, 0.0))
        elif m := _RANGE.match(p):
            a, b = float(m[1]), float(m[2])
            if a > 360 or b > 360:
                return None
            span = (b - a) % 360
            out.append(((a + span / 2) % 360, span / 2))
        elif p in _COMPASS:
            out.append((_COMPASS[p], 0.0))
        else:
            return None
    return out or None


@dataclass(frozen=True)
class Camera:
    osm_id: int
    x: float
    y: float
    mode: str  # "rear" | "axis" | "any"
    sectors: tuple[tuple[float, float], ...]  # (bearing, half_angle) pairs
    brand: str


def camera_from_tags(osm_id: int, x: float, y: float, tags: dict, params: ZoneParams,
                     omni: bool = False) -> Camera:
    """Build a Camera. Flock is modelled rear-only per its spec; other brands' plate side is
    undocumented, so they get both directions along the axis. `omni` drops heading entirely."""
    brand = tags.get("manufacturer") or tags.get("brand") or ""
    dirs = parse_direction(tags.get("direction") or tags.get("camera:direction"))
    if dirs is None:
        return Camera(osm_id, x, y, "any", ((0.0, 180.0),), brand)
    sectors = tuple((b, min(180.0, params.half_angle + extra)) for b, extra in dirs)
    mode = "any" if omni else ("rear" if brand.startswith("Flock") else "axis")
    return Camera(osm_id, x, y, mode, sectors, brand)


def zone_reference_length(cam: Camera, params: ZoneParams) -> float:
    """Length of a straight pass through the middle of the buffered zone: the length that
    counts as one full exposure (sector: from eps behind the pole to R + eps ahead)."""
    if cam.sectors[0][1] >= 180:
        return 2 * (params.range_m + params.eps_m)
    return params.range_m + 2 * params.eps_m


class LocalProjection:
    """Equirectangular projection about (lat0, lon0). Scale error ~ tan(lat0) * dlat(rad):
    about 0.2% across a metro, sub-millimetre across a single camera zone."""

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self.ky = math.radians(1.0) * EARTH_RADIUS_M
        self.kx = self.ky * math.cos(math.radians(lat0))

    def to_xy(self, lon, lat):
        return (np.asarray(lon) - self.lon0) * self.kx, (np.asarray(lat) - self.lat0) * self.ky

    def to_lonlat(self, x, y):
        return np.asarray(x) / self.kx + self.lon0, np.asarray(y) / self.ky + self.lat0


def wrap180(deg):
    """Wrap angles to [-180, 180)."""
    return (np.asarray(deg) + 180.0) % 360.0 - 180.0


def compass_bearing(dx, dy):
    """Compass bearing (deg, clockwise from north) of a displacement (east, north)."""
    return np.degrees(np.arctan2(dx, dy)) % 360.0


def sector_distance(px, py, bearing, half_angle, range_m):
    """Exact Euclidean distance from points (px, py), relative to the apex, to the sector
    {d <= R, |angle off bearing| <= alpha}. Zero inside.

    Inside the wedge the nearest sector point is radial (distance d - R past the arc).
    Outside it, the nearest point lies on the closer edge ray (length R), at angle
    phi = off-axis angle - alpha from p: project onto that ray, clamp to [0, R]. The arc
    is never closer for such points, because its nearest point is the ray's endpoint.
    """
    px, py = np.asarray(px, float), np.asarray(py, float)
    d = np.hypot(px, py)
    off_axis = np.abs(wrap180(compass_bearing(px, py) - bearing))
    phi = np.radians(np.clip(off_axis - half_angle, 0.0, 180.0))
    s = d * np.cos(phi)  # projection of p onto the nearer edge ray
    beyond_end = np.sqrt(np.maximum(d * d + range_m * range_m - 2 * d * range_m * np.cos(phi), 0.0))
    to_ray = np.where(s <= 0, d, np.where(s >= range_m, beyond_end, d * np.sin(phi)))
    return np.where(off_axis <= half_angle, np.maximum(d - range_m, 0.0), to_ray)


def heading_matches(heading, bearing, mode: str, tol: float):
    """Whether vehicle heading(s) satisfy the camera's heading mode."""
    heading = np.asarray(heading, float)
    if mode == "any":
        return np.ones(heading.shape, bool)
    off = np.abs(wrap180(heading - bearing))
    if mode == "rear":
        return off <= tol
    return np.minimum(off, 180.0 - off) <= tol  # axis: either travel direction


def captures(cam: Camera, x, y, heading, params: ZoneParams):
    """Vectorised predicate: is a vehicle at (x, y) with `heading` inside this camera's
    capture zone? This is the function the on-device alert engine ports."""
    px, py = np.asarray(x, float) - cam.x, np.asarray(y, float) - cam.y
    hit = np.zeros(np.broadcast(px, py, np.asarray(heading)).shape, bool)
    for bearing, half_angle in cam.sectors:
        near = sector_distance(px, py, bearing, half_angle, params.range_m) <= params.eps_m
        hit |= near & heading_matches(heading, bearing, cam.mode, params.heading_tol)
    return hit
