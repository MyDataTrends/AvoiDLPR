"""Build a road pack and its camera feed from an OSM extract.

Usage: python -m pipeline.build_pack <extract.osm.pbf> <out.fwr> [--regions spike/regions]

Writes <out>.fwr plus <out>.cameras.json: the DeFlock records (same schema as the CDN's
region tiles) inside the pack's bounding box.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import time
from pathlib import Path

from .osm_graph import build_graph
from .pack import pack_meta, pack_sections, write_pack

ROOT = Path(__file__).resolve().parents[1]


def cameras_in_bbox(regions: Path, bbox: list[float], margin_deg: float = 0.003) -> list[dict]:
    w, s, e, n = bbox
    found: dict[int, dict] = {}
    for f in sorted(regions.glob("*.json")):
        records = json.loads(f.read_text())
        if not isinstance(records, list):
            continue
        for r in records:
            if w - margin_deg <= r["lon"] <= e + margin_deg and s - margin_deg <= r["lat"] <= n + margin_deg:
                found[r["id"]] = {"id": r["id"], "lat": r["lat"], "lon": r["lon"], "tags": r.get("tags", {})}
    return [found[k] for k in sorted(found)]


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("extract", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--regions", type=Path, default=ROOT / "spike" / "regions",
                    help="directory of DeFlock region tiles (JSON arrays)")
    args = ap.parse_args(argv)

    t0 = time.perf_counter()
    graph = build_graph(args.extract)
    built_at = dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
    meta = pack_meta(graph, args.extract.name, built_at)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    size = write_pack(args.out, meta, pack_sections(graph))
    print(f"{args.out}: {size / 1e6:.1f} MB  {json.dumps(meta['counts'])}  [{time.perf_counter() - t0:.1f}s]")
    print(f"  {json.dumps(graph.stats)}")

    cameras = cameras_in_bbox(args.regions, meta["bbox"])
    cam_path = args.out.with_suffix(".cameras.json")
    cam_path.write_text(json.dumps({"source": "DeFlock region tiles (OpenStreetMap, ODbL)",
                                    "built_at": built_at, "bbox": meta["bbox"], "cameras": cameras}))
    print(f"{cam_path}: {len(cameras)} cameras")


if __name__ == "__main__":
    main()
