"""The lower 48 as one outline, for measuring or cutting a US-wide basemap out of the planet build.

Usage: python -m pipeline.us_outline [--cache work/poly] [--out lower48.geojson]

The union of Geofabrik's state polygons (the ones `check_regions` uses) without Alaska and
Hawaii, padded by about two kilometres so coastal roads and the causeways out to barrier islands
stay in, then simplified to about one.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from shapely.geometry import mapping
from shapely.ops import unary_union

from .check_regions import load_polys
from .regions import US

#: Not part of the contiguous US.
OUTSIDE = ("alaska", "hawaii")
PAD_DEG = 0.02
SIMPLIFY_DEG = 0.01


def lower48(polys: dict[str, object]):
    """The union of every state's polygon but Alaska's and Hawaii's, padded and simplified."""
    shapes = [p for key, p in polys.items() if key.removeprefix(US) not in OUTSIDE]
    return unary_union(shapes).buffer(PAD_DEG).simplify(SIMPLIFY_DEG)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cache", type=Path, default=Path("work/poly"), help="where the state polygons are kept")
    ap.add_argument("--out", type=Path, default=Path("lower48.geojson"))
    args = ap.parse_args(argv)
    shape = lower48(load_polys(args.cache))
    feature = {"type": "Feature", "properties": {"name": "lower 48"}, "geometry": mapping(shape)}
    args.out.write_text(json.dumps(feature), encoding="utf-8")
    parts = len(getattr(shape, "geoms", [shape]))
    print(f"{args.out}: {parts} polygon(s), bounds {[round(v, 2) for v in shape.bounds]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
