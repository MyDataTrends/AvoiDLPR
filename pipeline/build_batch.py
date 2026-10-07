"""Build every region in one batch: road packs (and basemaps), and decide which to publish.

Usage: python -m pipeline.build_batch <batch> [--region ID ...] [--mode full|roads]
                                      [--live regions.json] [--work work] [--data data]
                                      [--report report.json] [--no-basemap]

1. Get each state the batch needs, once, as drivable roads and turn restrictions (pipeline/roads.py).
   `--mode full` (the monthly build) downloads every state fresh. `--mode roads` (the nightly
   update) rolls the cached copy forward with the day's changes, and only downloads a state it
   has no copy of.
2. Merge them (border roads appear in both neighbours and are kept once) and cut each region out
   (`osmium extract`, keeping ways whole where they cross the edge). One region per pass: cutting
   a dozen at once keeps a dozen sets of ids in memory, which ran a runner out of its 16 GB.
3. Build each region's road pack (pipeline.build_pack -> data/packs/<id>.fwr) and decide whether it
   replaces the live one (pipeline/decide.py: unchanged, publish, defer or hold). A pack that isn't
   published is deleted, so staging keeps the live one.
4. Basemaps (apps/web/scripts/fetch-basemap.mjs -> data/basemap/<id>.pmtiles): in full mode for
   every region being published or unchanged; in roads mode only for a region with none online.
5. In full mode, each region's search index (pipeline/places.py -> data/places/<id>.fwp): named
   places, streets and house numbers, cut out of the states' places files the same way. Roads mode
   leaves the live one. An index that fails to build is reported; the region still ships without
   a new one.

A region that fails, or comes out too big for a phone, is reported and left out; the rest of the
batch still builds. The report lists every region's outcome, size and timing, and the build
workflow turns it into the run's summary. Needs osmium-tool, curl, node and the pmtiles CLI.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
import time
import traceback
from collections.abc import Callable, Sequence
from pathlib import Path

from . import build_pack, places, roads
from .decide import Decision, decide
from .deflock import http_get
from .pack import read_header
from .plan import plan
from .regions import Region, load_regions

#: A region with more road edges than this is too heavy for a phone (download, memory, time to
#: load): the build leaves it out, and its clip_bbox should shrink or the region split in two.
MAX_EDGES = 1_000_000
#: Above this the region still ships, flagged in the report.
WARN_EDGES = 700_000
ROOT = Path(__file__).resolve().parents[1]
BASEMAP_SCRIPT = ROOT / "apps" / "web" / "scripts" / "fetch-basemap.mjs"
BUILDS_INDEX = "https://build-metadata.protomaps.dev/builds.json"

Run = Callable[[Sequence[str]], None]
Decide = Callable[..., Decision]


def run_checked(cmd: Sequence[str]) -> None:
    print("+", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True)


def merge_command(sources: Sequence[Path], target: Path) -> list[str]:
    return ["osmium", "merge", *(str(s) for s in sources), "--overwrite", "-o", str(target)]


def extract_command(region: Region, source: Path, target: Path, strategy: str = "complete_ways") -> list[str]:
    """Cut a region out, keeping ways that cross its edge whole. (The places use "smart", which also
    completes multipolygons: an airport or a mall whose outline crosses the edge.)"""
    w, s, e, n = region.clip_bbox
    return ["osmium", "extract", "-b", f"{w},{s},{e},{n}", "--strategy", strategy, "--overwrite",
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


def prepare_sources(sources: Sequence[str], work: Path, run: Run, mode: str = "full",
                    updater: Callable[..., tuple[dict, bool]] = roads.update,
                    downloader: Callable[..., dict] = roads.fresh, rewind: int = 0,
                    stale: list[str] | None = None) -> tuple[Path, dict[str, str | None]]:
    """Each state's roads, merged; returns (the merged file, {extract: when its data is from}).

    In roads mode a state whose changes can't be had (its server doesn't answer) keeps the roads
    it has, and goes in `stale`: a day-old state beats a whole batch lost to one.
    """
    files, when = [], {}
    for path in sources:
        if mode == "roads":
            try:
                state = updater(path, work, run, rewind=rewind)[0]
            except roads.Unreachable as e:
                print(f"::warning::{e}; its roads stay as they were", flush=True)
                state = roads.read_state(work, path) or {}
                if stale is not None:
                    stale.append(path)
        else:
            state = downloader(path, work, run, places=True)
        files.append(roads.roads_file(work, path))
        when[path] = state.get("timestamp")
    if len(files) == 1:
        return files[0], when
    merged = work / "merged.osm.pbf"
    run(merge_command(files, merged))
    return merged, when


def prepare_places(sources: Sequence[str], work: Path, run: Run) -> Path | None:
    """The states' places files merged into one (None when there are none: roads mode). The
    states' own files go once merged: the runner's disk is small."""
    files = [f for path in sources if (f := roads.places_file(work, path)).exists()]
    if len(files) <= 1:
        return files[0] if files else None
    merged = work / "places-merged.osm.pbf"
    run(merge_command(files, merged))
    for f in files:
        f.unlink(missing_ok=True)
    return merged


def build_places(region: Region, source: Path, clips: Path, data: Path, run: Run, *, built_at: str,
                 osm_at: str | None) -> dict:
    """One region's search index; returns its report fields."""
    clip = clips / f"{region.id}.places.osm.pbf"
    run(extract_command(region, source, clip, strategy="smart"))
    try:
        ix = places.build_index(clip)
    finally:
        clip.unlink(missing_ok=True)
    size = places.write_index(data / "places" / f"{region.id}.fwp", ix, built_at=built_at, osm_at=osm_at)
    return {"places": places.counts(ix), "places_bytes": size}


def build_batch(regions: Sequence[Region], work: Path, data: Path, *, run: Run = run_checked, mode: str = "full",
                live: dict | None = None, basemap_build: str | None = None, basemaps: bool = True,
                decider: Decide | None = decide, now: dt.datetime | None = None, rewind: int = 0,
                **prepare) -> list[dict]:
    """Build every region; returns one report row per region (`ok` False when it failed).

    `live` is the published regions.json, if there is one. `decider=None` publishes every pack
    (a local build). `prepare` passes test doubles through to prepare_sources.
    """
    work.mkdir(parents=True, exist_ok=True)
    now = now or dt.datetime.now(dt.UTC)
    live_by_id = {e["id"]: e for e in (live or {}).get("regions", [])}
    sources = list(dict.fromkeys(g for r in regions for g in r.geofabrik))
    stale: list[str] = []
    merged, when = prepare_sources(sources, work, run, mode, rewind=rewind, stale=stale, **prepare)
    places_source = prepare_places(sources, work, run) if mode == "full" else None
    clips = work / "regions"
    clips.mkdir(parents=True, exist_ok=True)

    report = []
    for r in regions:
        row: dict = {"id": r.id, "name": r.name, "batch": r.batch, "ok": False}
        if behind := [g for g in r.geofabrik if g in stale]:
            row["stale"] = behind  # built with these states' roads from the last update
        t0 = time.perf_counter()
        pack, clip = data / "packs" / f"{r.id}.fwr", clips / f"{r.id}.osm.pbf"
        stamps = [when[g] for g in r.geofabrik if when.get(g)]
        osm_at = min(stamps) if stamps else None  # the area is as current as its stalest state
        try:
            run(extract_command(r, merged, clip))
            build_pack.main([str(clip), str(pack), *(["--osm-at", osm_at] if osm_at else [])])
            clip.unlink(missing_ok=True)
            counts = read_header(pack)["counts"]
            row.update(nodes=counts["nodes"], edges=counts["edges"], pack_bytes=pack.stat().st_size, osm_at=osm_at)
            if counts["edges"] > MAX_EDGES:
                pack.unlink()
                raise RuntimeError(f"too big for a phone: {counts['edges']:,} road edges (limit {MAX_EDGES:,}); "
                                   "shrink its clip_bbox or split it")
            if counts["edges"] > WARN_EDGES:
                row["warning"] = f"{counts['edges']:,} road edges is on the heavy side"

            entry = live_by_id.get(r.id)
            decision = decider(r.id, pack, entry, mode=mode, now=now) if decider else Decision("publish", "local build")
            row.update(status=decision.action, why=decision.why, changed=decision.changed)

            # The basemap is cut to the pack's bounding box, so it comes before an unpublished
            # pack is deleted: the monthly build refreshes an unchanged area's basemap too.
            wants_basemap = basemaps and (decision.action in ("publish", "unchanged") if mode == "full" else entry is None)
            try:
                if wants_basemap and decision.action != "hold":
                    run(basemap_command(r.id, basemap_build or latest_basemap_build()))
                    row["basemap_bytes"] = (data / "basemap" / f"{r.id}.pmtiles").stat().st_size
            finally:
                if decision.action != "publish":
                    pack.unlink(missing_ok=True)  # staging keeps the live pack
            row["ok"] = True
        except Exception as e:  # noqa: BLE001 - one bad region mustn't sink the batch
            row["error"] = f"{type(e).__name__}: {e}"
            row["status"] = "failed"
            traceback.print_exc()
        if places_source is not None and row["ok"]:
            try:
                row.update(build_places(r, places_source, clips, data, run,
                                        built_at=now.isoformat(timespec="seconds"), osm_at=osm_at))
            except Exception as e:  # noqa: BLE001 - search is extra: the region still ships
                row["places_error"] = f"{type(e).__name__}: {e}"
                traceback.print_exc()
        row["seconds"] = round(time.perf_counter() - t0, 1)
        report.append(row)
        print(f"{r.id}: {row['status']}" + (f" ({row.get('why') or row.get('error')})" if row.get("why") or row.get("error") else ""),
              flush=True)
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("batch", help="a batch name from `python -m pipeline.plan`")
    ap.add_argument("--region", action="append", help="only these regions of the batch (repeatable)")
    ap.add_argument("--mode", choices=("full", "roads"), default="full",
                    help="full: fresh downloads and basemaps (monthly); roads: roll the cached roads forward (nightly)")
    ap.add_argument("--live", type=Path, help="the published regions.json, to compare with")
    ap.add_argument("--work", type=Path, default=Path("work"), help="scratch directory for downloads")
    ap.add_argument("--data", type=Path, default=Path("data"))
    ap.add_argument("--report", type=Path, help="write the per-region report here (JSON)")
    ap.add_argument("--no-basemap", action="store_true", help="road packs only")
    ap.add_argument("--rewind", type=int, default=0,
                    help="roads mode: re-apply this many of the latest change files (harmless; for testing)")
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
    live = json.loads(args.live.read_text(encoding="utf-8")) if args.live and args.live.exists() else None
    build = None if args.no_basemap else latest_basemap_build()
    report = build_batch(regions, args.work, args.data, mode=args.mode, live=live, basemap_build=build,
                         basemaps=not args.no_basemap, rewind=args.rewind)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps({"batch": args.batch, "mode": args.mode, "basemap_build": build,
                                           "regions": report}, indent=2), encoding="utf-8")
    failed = [row["id"] for row in report if not row["ok"]]
    counts = {s: sum(1 for row in report if row.get("status") == s) for s in ("publish", "unchanged", "defer", "hold")}
    print(f"{len(report) - len(failed)} of {len(report)} regions built: " + ", ".join(f"{n} {s}" for s, n in counts.items() if n)
          + (f"; failed: {', '.join(failed)}" if failed else ""))
    return 0 if len(failed) < len(report) else 1


if __name__ == "__main__":
    sys.exit(main())
