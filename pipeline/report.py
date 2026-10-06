"""Summarise a data build as Markdown: what was built, how big, and what went wrong.

Usage: python -m pipeline.report [--release release] REPORT.json [REPORT.json ...]

Takes the per-batch reports from `pipeline.build_batch --report` and the staged release
(regions.json and the camera feeds) and prints a table with a row per region, worst news first,
plus the totals that matter for the free tier: the bucket's size and the heaviest download.
The build workflow appends it to the run's summary page.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .build_batch import WARN_EDGES

FREE_TIER_GB = 10


def mb(n: float | None) -> str:
    return "" if n is None else f"{n / 1e6:.1f}"


def render(reports: list[dict], manifest: dict | None, release: Path) -> str:
    listed = {e["id"]: e for e in (manifest or {}).get("regions", [])}
    rows = [row for rep in reports for row in rep["regions"]]
    failed = [r for r in rows if not r["ok"]]
    out = [f"## Map data build: {len(rows) - len(failed)} of {len(rows)} regions built", ""]
    if manifest:
        packs = sum(e["pack"]["bytes"] for e in listed.values())
        basemaps = sum(e["basemap"]["bytes"] for e in listed.values())
        heaviest = max(listed.values(), key=lambda e: e["pack"]["bytes"], default=None)
        out += [
            f"- **Published regions:** {len(listed)}",
            f"- **Bucket size:** {(packs + basemaps) / 1e9:.2f} GB ({packs / 1e9:.2f} GB road packs, "
            f"{basemaps / 1e9:.2f} GB basemaps) of the {FREE_TIER_GB} GB free tier",
        ]
        if heaviest:
            out.append(f"- **Biggest download:** {heaviest['name']}, {mb(heaviest['pack']['bytes'])} MB gzipped "
                       f"({heaviest['pack']['edges']:,} road edges)")
        out.append("")
    if failed:
        out += ["### Failed", ""] + [f"- **{r['id']}** ({r['batch']}): {r.get('error', '?')}" for r in failed] + [""]
    warned = [r for r in rows if r.get("warning")]
    if warned:
        out += ["### Heavy", ""] + [f"- **{r['id']}**: {r['warning']}" for r in warned] + [""]

    out += ["| Region | Batch | Road edges | Pack MB (gzip) | Basemap MB (zoom) | Cameras | Build s |",
            "|---|---|--:|--:|--:|--:|--:|"]
    order = sorted(rows, key=lambda r: (r["ok"], -(r.get("edges") or 0)))
    for r in order:
        e = listed.get(r["id"])
        feed = release / "cameras" / f"{r['id']}.json"
        cams = len(json.loads(feed.read_text(encoding="utf-8"))["cameras"]) if feed.exists() else None
        edges = f"{r['edges']:,}" if r.get("edges") is not None else ""
        if r.get("edges", 0) > WARN_EDGES:
            edges = f"**{edges}**"
        gz = mb(e["pack"]["bytes"]) if e else ""
        zoom = f" (z{e['basemap']['maxzoom']})" if e and e["basemap"].get("maxzoom") is not None else ""
        status = "" if r["ok"] else " ❌"
        out.append(f"| {r['name']}{status} | {r['batch']} | {edges} | {gz} | {mb(r.get('basemap_bytes'))}{zoom} | "
                   f"{'' if cams is None else cams} | {r.get('seconds', '')} |")
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("reports", type=Path, nargs="+")
    ap.add_argument("--release", type=Path, default=Path("release"))
    args = ap.parse_args(argv)
    reports = [json.loads(p.read_text(encoding="utf-8")) for p in args.reports if p.exists()]
    manifest_path = args.release / "regions.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else None
    sys.stdout.write(render(reports, manifest, args.release))
    return 0


if __name__ == "__main__":
    sys.exit(main())
