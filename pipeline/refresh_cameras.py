"""Refresh the camera feed of every region from DeFlock: the hourly job.

Usage: python -m pipeline.refresh_cameras [--out release] [--region dallas] [--listed-in regions.json]

Writes <out>/cameras/<region>.json, the same files `pipeline.release` stages. They are small and
change often, so they're published separately from the road packs and the app revalidates them
on every load. A failed or empty fetch leaves the previous file in place and exits non-zero, so
a DeFlock outage never replaces a good feed with an empty one.

Without --region it also writes <out>/cameras/us.json.gz: every camera in the lower 48, positions
only, for the map zoomed out over the whole country (see `encode_national`).
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import sys
from pathlib import Path

from .deflock import caching, fetch_cameras
from .regions import Region, load_regions

SOURCE = "DeFlock region tiles (OpenStreetMap, ODbL)"
#: A feed with fewer cameras than this fraction of the previous one is treated as a failed fetch.
MIN_FRACTION_OF_PREVIOUS = 0.5
#: Roads that cross the clip rectangle are kept whole in the road pack, so the pack reaches a
#: little past it (about 0.02 degrees in Dallas); the camera feed covers that margin too.
PAD_DEG = 0.03

#: Every camera in the country, as the release names it (the manifest's top-level `cameras`).
NATIONAL_FEED = "cameras/us.json.gz"
#: The lower 48 with a little room, as the country's basemap covers it.
US_BBOX = (-125.0, 24.3, -66.8, 49.5)
#: Positions in the national file are whole numbers of this fraction of a degree (about 11 m).
SCALE = 10_000
#: ... sorted into rows this many of those high (a tenth of a degree, about 11 km).
ROW = 1_000


def feed_bbox(region: Region) -> tuple[float, float, float, float]:
    w, s, e, n = region.clip_bbox
    return (w - PAD_DEG, s - PAD_DEG, e + PAD_DEG, n + PAD_DEG)


def feed_for(region: Region, cameras: list[dict], built_at: str) -> dict:
    return {"source": SOURCE, "built_at": built_at, "bbox": list(feed_bbox(region)), "cameras": cameras}


def refresh(region: Region, out: Path, *, fetch=None) -> int:
    """Write the region's feed; returns the camera count. Raises if the result looks broken."""
    kwargs = {} if fetch is None else {"fetch": fetch}
    cameras = fetch_cameras(feed_bbox(region), **kwargs)
    target = out / "cameras" / f"{region.id}.json"
    if not cameras:
        raise RuntimeError(f"{region.id}: DeFlock returned no cameras inside {feed_bbox(region)}")
    if target.exists():
        previous = len(json.loads(target.read_text(encoding="utf-8")).get("cameras", []))
        if previous and len(cameras) < previous * MIN_FRACTION_OF_PREVIOUS:
            raise RuntimeError(f"{region.id}: {len(cameras)} cameras vs {previous} before; refusing to publish a feed that shrank by more than half")
    target.parent.mkdir(parents=True, exist_ok=True)
    built_at = dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(feed_for(region, cameras, built_at), separators=(",", ":")), encoding="utf-8")
    tmp.replace(target)
    return len(cameras)


def encode_national(cameras: list[dict]) -> list[int]:
    """Where every camera is, as compactly as JSON allows: [dlon, dlat, dlon, dlat, ...] in
    1/SCALE degrees, each pair a step from the camera before (the first from 0, 0). Sorted into
    rows, west to east within a row, the steps are short and the file gzips to a few bytes a
    camera. Two cameras on one pole stay two: the map counts them both."""
    points = sorted(((round(c["lon"] * SCALE), round(c["lat"] * SCALE)) for c in cameras),
                    key=lambda p: (p[1] // ROW, p[0], p[1]))
    steps: list[int] = []
    x0 = y0 = 0
    for x, y in points:
        steps += (x - x0, y - y0)
        x0, y0 = x, y
    return steps


def decode_national(steps: list[int]) -> list[tuple[float, float]]:
    """(lon, lat) of every camera in a national file, as the app reads it."""
    x = y = 0
    points = []
    for i in range(0, len(steps), 2):
        x += steps[i]
        y += steps[i + 1]
        points.append((x / SCALE, y / SCALE))
    return points


def read_national(path: Path) -> dict:
    return json.loads(gzip.decompress(path.read_bytes()))


def refresh_national(out: Path, *, fetch=None) -> int:
    """Write the national file (NATIONAL_FEED); returns the camera count. Raises, leaving the
    previous file, on the same signs of a failed fetch as a region's feed."""
    kwargs = {} if fetch is None else {"fetch": fetch}
    cameras = fetch_cameras(US_BBOX, **kwargs)
    target = out / NATIONAL_FEED
    if not cameras:
        raise RuntimeError(f"us: DeFlock returned no cameras inside {US_BBOX}")
    if target.exists():
        previous = read_national(target).get("count", 0)
        if previous and len(cameras) < previous * MIN_FRACTION_OF_PREVIOUS:
            raise RuntimeError(f"us: {len(cameras)} cameras vs {previous} before; refusing to publish a feed that shrank by more than half")
    target.parent.mkdir(parents=True, exist_ok=True)
    feed = {
        "source": SOURCE, "built_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"), "bbox": list(US_BBOX),
        "count": len(cameras), "scale": SCALE, "points": encode_national(cameras),
    }
    tmp = target.with_name(target.name + ".tmp")
    # mtime=0: the same cameras make the same bytes.
    tmp.write_bytes(gzip.compress(json.dumps(feed, separators=(",", ":")).encode(), compresslevel=9, mtime=0))
    tmp.replace(target)
    return len(cameras)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=Path("release"))
    ap.add_argument("--region", help="only this region id (default: all, and the national file)")
    ap.add_argument("--listed-in", type=Path, metavar="MANIFEST",
                    help="only the regions this manifest lists, if it exists (the hourly job passes the live "
                         "regions.json, so a region that isn't published yet gets no feed)")
    args = ap.parse_args(argv)
    regions = [r for r in load_regions() if args.region in (None, r.id)]
    if args.listed_in and args.listed_in.exists():
        listed = {e["id"] for e in json.loads(args.listed_in.read_text(encoding="utf-8"))["regions"]}
        regions = [r for r in regions if r.id in listed]
    if not regions:
        print(f"no such region: {args.region}", file=sys.stderr)
        return 2
    fetch = caching()
    failed = 0
    for r in regions:
        try:
            print(f"{r.id}: {refresh(r, args.out, fetch=fetch)} cameras -> {args.out / 'cameras' / (r.id + '.json')}")
        except Exception as e:  # noqa: BLE001 - report every region, then fail the run
            failed += 1
            print(f"{r.id}: FAILED: {e}", file=sys.stderr)
    if args.region is None:
        try:
            count = refresh_national(args.out, fetch=fetch)
            size = (args.out / NATIONAL_FEED).stat().st_size
            print(f"us: {count:,} cameras -> {args.out / NATIONAL_FEED} ({size / 1e3:.0f} KB)")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"us: FAILED: {e}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
