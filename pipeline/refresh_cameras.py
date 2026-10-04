"""Refresh the camera feed of every region from DeFlock: the hourly job.

Usage: python -m pipeline.refresh_cameras [--out release] [--region dallas]

Writes <out>/cameras/<region>.json, the same files `pipeline.release` stages. They are small and
change often, so they're published separately from the road packs and the app revalidates them
on every load. A failed or empty fetch leaves the previous file in place and exits non-zero, so
a DeFlock outage never replaces a good feed with an empty one.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

from .deflock import fetch_cameras
from .regions import Region, load_regions

SOURCE = "DeFlock region tiles (OpenStreetMap, ODbL)"
#: A feed with fewer cameras than this fraction of the previous one is treated as a failed fetch.
MIN_FRACTION_OF_PREVIOUS = 0.5
#: Roads that cross the clip rectangle are kept whole in the road pack, so the pack reaches a
#: little past it (about 0.02 degrees in Dallas); the camera feed covers that margin too.
PAD_DEG = 0.03


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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=Path("release"))
    ap.add_argument("--region", help="only this region id (default: all)")
    args = ap.parse_args(argv)
    regions = [r for r in load_regions() if args.region in (None, r.id)]
    if not regions:
        print(f"no such region: {args.region}", file=sys.stderr)
        return 2
    failed = 0
    for r in regions:
        try:
            print(f"{r.id}: {refresh(r, args.out)} cameras -> {args.out / 'cameras' / (r.id + '.json')}")
        except Exception as e:  # noqa: BLE001 - report every region, then fail the run
            failed += 1
            print(f"{r.id}: FAILED: {e}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
