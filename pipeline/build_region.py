"""Build one region's road pack (and, with --basemap, its basemap) from OpenStreetMap.

Usage: python -m pipeline.build_region <region> [--work work] [--data data] [--basemap]
       python -m pipeline.build_region dallas --pbf some.osm.pbf   # an extract you already have

The same steps as one region of `pipeline.build_batch`: download the region's state extracts, keep
the roads, merge them, cut the region out (osmium-tool, `apt install osmium-tool`) and build the
pack into data/packs/<region>.fwr. With --pbf the file is used as it is: no download, no clipping
and no osmium. Then fetch the basemap (if you didn't pass --basemap), refresh the cameras and
stage the release; docs/DEVELOPING.md has the commands.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import build_pack
from .build_batch import Run, build_batch, run_checked
from .regions import Region, get_region


def build_region(region: Region, work: Path, data: Path, *, pbf: Path | None = None, basemap: bool = False,
                 run: Run = run_checked) -> Path:
    """Returns the pack's path."""
    pack = data / "packs" / f"{region.id}.fwr"
    if pbf is not None:
        build_pack.main([str(pbf), str(pack)])
        return pack
    # A local build has nothing published to compare with: it keeps what it builds.
    row = build_batch([region], work, data, run=run, basemaps=basemap, decider=None)[0]
    if not row["ok"]:
        raise RuntimeError(f"{region.id}: {row['error']}")
    return pack


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("region", help="a region id from pipeline/regions.json")
    ap.add_argument("--work", type=Path, default=Path("work"), help="scratch directory for downloads")
    ap.add_argument("--data", type=Path, default=Path("data"))
    ap.add_argument("--pbf", type=Path, help="use this OSM extract as it is instead of downloading one")
    ap.add_argument("--basemap", action="store_true", help="also fetch the region's basemap")
    args = ap.parse_args(argv)
    pack = build_region(get_region(args.region), args.work, args.data, pbf=args.pbf, basemap=args.basemap)
    print(f"built {pack}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
