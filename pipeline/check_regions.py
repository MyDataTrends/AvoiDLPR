"""Check each region's list of extracts against the real state boundaries.

Usage: python -m pipeline.check_regions [--cache work/poly]

Downloads Geofabrik's boundary polygon (`<extract>.poly`, a few kilobytes of text) for every US
state once, then works out which states each region's rectangle reaches into. Land in the
rectangle that none of the region's extracts contain would be a hole in its road network, so that
fails the check and names the state to add. An extract the rectangle doesn't touch is reported but
doesn't fail: it only costs a download.
"""

from __future__ import annotations

import argparse
import math
import sys
from collections.abc import Callable
from pathlib import Path

from shapely.geometry import Polygon, box
from shapely.ops import unary_union

from .deflock import http_get
from .regions import GEOFABRIK, US, US_STATES, Region, load_regions

#: Uncovered land above this (km^2) fails the check; Geofabrik's polygons overlap their neighbours
#: by a few hundred metres, so tiny slivers are noise.
MAX_UNCOVERED_KM2 = 1.0
#: A listed extract overlapping the rectangle by less than this is called out as unneeded.
MIN_USEFUL_KM2 = 0.5

Fetch = Callable[[str], bytes | None]


def parse_poly(text: str) -> Polygon | object:
    """An osmosis .poly file -> shapely geometry (rings whose name starts with '!' are holes)."""
    lines = [ln.strip() for ln in text.splitlines()]
    rings: list[tuple[bool, list[tuple[float, float]]]] = []
    i = 1  # line 0 is the file's name
    while i < len(lines) and lines[i] != "END":
        hole, coords = lines[i].startswith("!"), []
        i += 1
        while lines[i] != "END":
            if lines[i]:
                lon, lat = lines[i].split()[:2]
                coords.append((float(lon), float(lat)))
            i += 1
        rings.append((hole, coords))
        i += 1
    shells = [Polygon(c) for hole, c in rings if not hole and len(c) >= 3]
    holes = [Polygon(c) for hole, c in rings if hole and len(c) >= 3]
    shape = unary_union([p.buffer(0) for p in shells])
    return shape.difference(unary_union([h.buffer(0) for h in holes])) if holes else shape


def km2(geom, lat: float) -> float:
    """Approximate area of a lon/lat geometry near latitude `lat`, in km^2."""
    return geom.area * 111.32 ** 2 * math.cos(math.radians(lat))


def load_polys(cache: Path, fetch: Fetch = http_get) -> dict[str, object]:
    polys = {}
    cache.mkdir(parents=True, exist_ok=True)
    for slug in US_STATES:
        path = cache / f"{slug}.poly"
        if not path.exists():
            raw = fetch(f"{GEOFABRIK}/{US}{slug}.poly")
            if raw is None:
                raise RuntimeError(f"no boundary polygon for {slug}")
            path.write_bytes(raw)
        polys[f"{US}{slug}"] = parse_poly(path.read_text(encoding="utf-8"))
    return polys


def check_region(region: Region, polys: dict[str, object]) -> tuple[list[str], list[str]]:
    """Returns (errors, notes) for one region."""
    w, s, e, n = region.clip_bbox
    rect, lat = box(w, s, e, n), (s + n) / 2
    errors, notes = [], []
    unknown = [g for g in region.geofabrik if g not in polys]
    if unknown:
        return [f"{region.id}: no boundary known for {', '.join(unknown)}"], []
    listed = unary_union([polys[g] for g in region.geofabrik]).intersection(rect)
    for g in region.geofabrik:
        if km2(polys[g].intersection(rect), lat) < MIN_USEFUL_KM2:
            notes.append(f"{region.id}: {g} doesn't reach the rectangle; it can be dropped")
    missing = []
    for g, poly in polys.items():
        if g in region.geofabrik:
            continue
        gap = poly.intersection(rect).difference(listed)
        if not gap.is_empty and km2(gap, lat) > MAX_UNCOVERED_KM2:
            missing.append(f"{g} ({km2(gap, lat):.0f} km2)")
    if missing:
        errors.append(f"{region.id}: the rectangle reaches into {', '.join(missing)}, which it doesn't list")
    return errors, notes


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cache", type=Path, default=Path("work/poly"), help="where to keep the downloaded polygons")
    args = ap.parse_args(argv)
    polys = load_polys(args.cache)
    regions = load_regions()
    errors = []
    for r in regions:
        errs, notes = check_region(r, polys)
        errors += errs
        for msg in errs:
            print(f"ERROR {msg}", file=sys.stderr)
        for msg in notes:
            print(f"note  {msg}")
    print(f"{len(regions)} regions checked, {len(errors)} with missing extracts")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
