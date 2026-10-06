"""Plan the map-data build: which batches to run, and what each one downloads.

Usage: python -m pipeline.plan [--region ID] [--github-output]

Prints the batches as JSON: [{"batch": "southeast", "regions": [ids], "sources": [extracts]}].
Regions are batched by their home state (see `US_STATES` in pipeline/regions.py), so a state is
downloaded once per batch however many of its cities are built. With --github-output it also
writes `matrix=<json>` to $GITHUB_OUTPUT, which .github/workflows/build-data.yml runs one job per.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .regions import Region, load_regions


def plan(regions: list[Region], only: str | None = None) -> list[dict]:
    if only:
        regions = [r for r in regions if r.id == only]
        if not regions:
            raise KeyError(f"no region {only!r} in pipeline/regions.json")
    batches: dict[str, dict] = {}
    for r in regions:
        b = batches.setdefault(r.batch, {"batch": r.batch, "regions": [], "sources": []})
        b["regions"].append(r.id)
        b["sources"] += [g for g in r.geofabrik if g not in b["sources"]]
    # Biggest first, so the longest job starts first.
    return sorted(batches.values(), key=lambda b: (-len(b["regions"]), b["batch"]))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--region", help="plan just this region (default: all)")
    ap.add_argument("--github-output", action="store_true", help="also write matrix=... to $GITHUB_OUTPUT")
    args = ap.parse_args(argv)
    batches = plan(load_regions(), args.region or None)
    print(json.dumps(batches, indent=2))
    if args.github_output:
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as out:
            out.write(f"matrix={json.dumps({'include': batches}, separators=(',', ':'))}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
