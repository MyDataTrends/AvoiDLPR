"""Build every region in one batch: road packs and basemaps, from fresh OpenStreetMap data.

Usage: python -m pipeline.build_batch <batch> [--region ID ...] [--work work] [--data data]
                                      [--report report.json] [--no-basemap]

1. Download each state extract the batch needs, once, and keep only drivable roads and turn
   restrictions (`osmium tags-filter`), which makes them several times smaller.
2. Merge them (border roads appear in both neighbours and are kept once) and cut each region out
   (`osmium extract`, keeping ways whole where they cross the edge). One region per pass: cutting
   a dozen at once keeps a dozen sets of ids in memory, which ran a runner out of its 16 GB.
3. Build each region's road pack (pipeline.build_pack -> data/packs/<id>.fwr) and basemap
   (apps/web/scripts/fetch-basemap.mjs -> data/basemap/<id>.pmtiles).

A region that fails, or comes out too big for a phone, is reported and left out; the rest of the
batch still builds. The report lists every region's sizes and timings, and the build workflow
turns it into the run's summary. Needs osmium-tool, curl, node and the pmtiles CLI.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import traceback
from collections.abc import Callable, Sequence
from pathlib import Path

from . import build_pack
from .deflock import http_get
from .osm_graph import HIGHWAY_CLASSES
from .pack import read_header
from .plan import plan
from .regions import Region, geofabrik_url, load_regions

#: A region with more road edges than this is too heavy for a phone (download, memory, time to
#: load): the build leaves it out, and its clip_bbox should shrink or the region split in two.
MAX_EDGES = 1_000_000
#: Above this the region still ships, flagged in the report.
WARN_EDGES = 700_000
ROOT = Path(__file__).resolve().parents[1]
BASEMAP_SCRIPT = ROOT / "apps" / "web" / "scripts" / "fetch-basemap.mjs"
BUILDS_INDEX = "https://build-metadata.protomaps.dev/builds.json"

Run = Callable[[Sequence[str]], None]


def run_checked(cmd: Sequence[str]) -> None:
    print("+", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True)


def slug(path: str) -> str:
    return path.replace("/", "_")


def download_command(url: str, target: Path) -> list[str]:
    return ["curl", "-fL", "--retry", "5", "--retry-delay", "10", "--retry-all-errors", "-o", str(target), url]


def filter_command(source: Path, target: Path) -> list[str]:
    return ["osmium", "tags-filter", str(source), f"w/highway={','.join(HIGHWAY_CLASSES)}", "r/type=restriction",
            "--overwrite", "-o", str(target)]


def merge_command(sources: Sequence[Path], target: Path) -> list[str]:
    return ["osmium", "merge", *(str(s) for s in sources), "--overwrite", "-o", str(target)]


def extract_command(region: Region, source: Path, target: Path) -> list[str]:
    w, s, e, n = region.clip_bbox
    return ["osmium", "extract", "-b", f"{w},{s},{e},{n}", "--strategy", "complete_ways", "--overwrite",
            "-o", str(target), str(source)]


def basemap_command(region_id: str, build: str) -> list[str]:
    return ["node", str(BASEMAP_SCRIPT), "--region", region_id, "--build", build, "--force"]


def latest_basemap_build(fetch=http_get) -> str:
    """The newest Protomaps planet build (e.g. "20261005"), so a whole batch uses the same one."""
    builds = json.loads(fetch(BUILDS_INDEX) or b"[]")
    keys = sorted(b["key"][:-len(".pmtiles")] for b in builds
                  if b.get("key", "").endswith(".pmtiles") and b["key"][:8].isdigit() and len(b["key"]) == 16)
    if not keys:
        raise RuntimeError(f"no planet builds listed at {BUILDS_INDEX}")
    return keys[-1]


def prepare_sources(sources: Sequence[str], work: Path, run: Run) -> Path:
    """Download and road-filter each extract, merge them, and return the merged file."""
    roads = []
    for path in sources:
        raw = work / "src" / f"{slug(path)}.osm.pbf"
        filtered = work / "roads" / f"{slug(path)}.osm.pbf"
        filtered.parent.mkdir(parents=True, exist_ok=True)
        if not filtered.exists():
            raw.parent.mkdir(parents=True, exist_ok=True)
            if not raw.exists():
                run(download_command(geofabrik_url(path), raw))
            run(filter_command(raw, filtered))
            raw.unlink(missing_ok=True)  # the runner's disk is small; only the roads are needed
        roads.append(filtered)
    if len(roads) == 1:
        return roads[0]
    merged = work / "roads" / "merged.osm.pbf"
    run(merge_command(roads, merged))
    return merged


def build_batch(regions: Sequence[Region], work: Path, data: Path, *, run: Run = run_checked,
                basemap_build: str | None = None, basemaps: bool = True) -> list[dict]:
    """Build every region; returns one report row per region (`ok` False when it was left out)."""
    work.mkdir(parents=True, exist_ok=True)
    sources = [g for r in regions for g in r.geofabrik]
    merged = prepare_sources(list(dict.fromkeys(sources)), work, run)
    clips = work / "regions"
    clips.mkdir(parents=True, exist_ok=True)

    report = []
    for r in regions:
        row: dict = {"id": r.id, "name": r.name, "batch": r.batch, "ok": False}
        t0 = time.perf_counter()
        pack, clip = data / "packs" / f"{r.id}.fwr", clips / f"{r.id}.osm.pbf"
        try:
            run(extract_command(r, merged, clip))
            build_pack.main([str(clip), str(pack)])
            clip.unlink(missing_ok=True)
            counts = read_header(pack)["counts"]
            row.update(nodes=counts["nodes"], edges=counts["edges"], pack_bytes=pack.stat().st_size)
            if counts["edges"] > MAX_EDGES:
                pack.unlink()
                raise RuntimeError(f"too big for a phone: {counts['edges']:,} road edges (limit {MAX_EDGES:,}); "
                                   "shrink its clip_bbox or split it")
            if counts["edges"] > WARN_EDGES:
                row["warning"] = f"{counts['edges']:,} road edges is on the heavy side"
            if basemaps:
                run(basemap_command(r.id, basemap_build or latest_basemap_build()))
                row["basemap_bytes"] = (data / "basemap" / f"{r.id}.pmtiles").stat().st_size
            row["ok"] = True
        except Exception as e:  # noqa: BLE001 - one bad region mustn't sink the batch
            row["error"] = f"{type(e).__name__}: {e}"
            traceback.print_exc()
        row["seconds"] = round(time.perf_counter() - t0, 1)
        report.append(row)
        print(f"{r.id}: {'ok' if row['ok'] else 'FAILED ' + row['error']}", flush=True)
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("batch", help="a batch name from `python -m pipeline.plan`")
    ap.add_argument("--region", action="append", help="only these regions of the batch (repeatable)")
    ap.add_argument("--work", type=Path, default=Path("work"), help="scratch directory for downloads")
    ap.add_argument("--data", type=Path, default=Path("data"))
    ap.add_argument("--report", type=Path, help="write the per-region report here (JSON)")
    ap.add_argument("--no-basemap", action="store_true", help="road packs only")
    args = ap.parse_args(argv)

    batches = {b["batch"]: b for b in plan(load_regions())}
    if args.batch not in batches:
        print(f"no batch {args.batch!r}; batches: {', '.join(sorted(batches))}", file=sys.stderr)
        return 2
    wanted = set(args.region or batches[args.batch]["regions"])
    regions = [r for r in load_regions() if r.batch == args.batch and r.id in wanted]
    if not regions:
        print(f"none of {sorted(wanted)} is in batch {args.batch!r}", file=sys.stderr)
        return 2
    build = None if args.no_basemap else latest_basemap_build()
    report = build_batch(regions, args.work, args.data, basemap_build=build, basemaps=not args.no_basemap)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps({"batch": args.batch, "basemap_build": build, "regions": report}, indent=2),
                               encoding="utf-8")
    failed = [row["id"] for row in report if not row["ok"]]
    print(f"{len(report) - len(failed)} of {len(report)} regions built" + (f"; failed: {', '.join(failed)}" if failed else ""))
    return 0 if len(failed) < len(report) else 1


if __name__ == "__main__":
    sys.exit(main())
