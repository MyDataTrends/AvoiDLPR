"""Build a region's road pack from OpenStreetMap: download, clip, build.

Usage: python -m pipeline.build_region <region> [--work work] [--data data]
       python -m pipeline.build_region dallas --pbf some.osm.pbf --no-clip   # a local extract

1. Download the region's Geofabrik state extract (unless --pbf names a local file).
2. Clip it to the region's rectangle with `osmium extract` (osmium-tool, `apt install osmium-tool`),
   keeping ways whole where they cross the edge, so no road is cut in half.
3. Build the pack with the same code as `pipeline.build_pack` -> data/packs/<region>.fwr.

Then fetch the basemap (`npm run fetch-basemap -w @flockwatch/web -- --region <id>`), refresh the
cameras and stage the release; docs/DEPLOY.md and .github/workflows/build-data.yml run exactly this.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

from . import build_pack
from .regions import Region, get_region

Run = Callable[[Sequence[str]], None]


def run_checked(cmd: Sequence[str]) -> None:
    print("+", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True)


def download_command(region: Region, target: Path) -> list[str]:
    return ["curl", "-fL", "--retry", "3", "--retry-delay", "5", "-o", str(target), region.geofabrik_url]


def clip_command(region: Region, source: Path, target: Path) -> list[str]:
    w, s, e, n = region.clip_bbox
    return ["osmium", "extract", "-b", f"{w},{s},{e},{n}", "--strategy", "complete_ways",
            "--overwrite", "-o", str(target), str(source)]


def build_region(region: Region, work: Path, data: Path, *, pbf: Path | None = None, clip: bool = True,
                 run: Run = run_checked) -> Path:
    """Returns the pack's path."""
    work.mkdir(parents=True, exist_ok=True)
    if pbf is None:
        source = work / f"{region.geofabrik.replace('/', '_')}.osm.pbf"
        if not source.exists():
            run(download_command(region, source))
    else:
        source = pbf
    if clip:
        if shutil.which("osmium") is None and run is run_checked:
            raise RuntimeError("osmium-tool isn't installed (apt install osmium-tool), or pass --no-clip for an already-clipped extract")
        clipped = work / f"{region.id}.osm.pbf"
        run(clip_command(region, source, clipped))
    else:
        clipped = source
    pack = data / "packs" / f"{region.id}.fwr"
    build_pack.main([str(clipped), str(pack)])
    return pack


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("region", help="a region id from pipeline/regions.json")
    ap.add_argument("--work", type=Path, default=Path("work"), help="scratch directory for downloads")
    ap.add_argument("--data", type=Path, default=Path("data"))
    ap.add_argument("--pbf", type=Path, help="use this OSM extract instead of downloading one")
    ap.add_argument("--no-clip", action="store_true", help="the extract is already the right size")
    args = ap.parse_args(argv)
    pack = build_region(get_region(args.region), args.work, args.data, pbf=args.pbf, clip=not args.no_clip)
    print(f"built {pack}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
