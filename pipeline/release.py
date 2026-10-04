"""Stage a release: the exact set of static files the web app loads.

Usage: python -m pipeline.release [--data data] [--out release]

    release/
      regions.json                       what exists, where, and how big (short cache)
      packs/<id>.<hash>.fwr              road pack, content-hashed (cache forever)
      basemap/<id>.<hash>.pmtiles        Protomaps extract, content-hashed (cache forever)
      basemap/assets/...                 label fonts and icon sprites (cache forever)
      cameras/<id>.json                  camera feed, rewritten hourly (revalidate)

The same tree is what you upload to object storage (see docs/DEPLOY.md) and what the dev and
phone servers serve locally, so development runs the production layout. Hashed names mean a new
pack or basemap is just a new file plus a new manifest: nothing cached ever goes stale, and old
files stay valid for pages that are still open.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

from .pack import read_header
from .regions import Region, load_regions

SCHEMA = 1
HASH_CHARS = 10
ASSETS = {
    "glyphs": "basemap/assets/fonts/{fontstack}/{range}.pbf",
    "sprite": "basemap/assets/sprites/v4/light",
}


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def place(src: Path, dst: Path) -> None:
    """Hard-link where possible (same volume), else copy: staging shouldn't double the disk."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def stage_hashed(src: Path, out_dir: Path, region_id: str, suffix: str) -> tuple[str, str, int]:
    """Place `src` as <region>.<hash><suffix>, removing older versions; returns (relative path, sha, bytes)."""
    digest = sha256_of(src)
    name = f"{region_id}.{digest[:HASH_CHARS]}{suffix}"
    target = out_dir / name
    place(src, target)
    for old in out_dir.glob(f"{region_id}.*{suffix}"):
        if old != target:
            old.unlink()
    return f"{out_dir.name}/{name}", digest, src.stat().st_size


def stage_region(region: Region, data: Path, out: Path) -> dict | None:
    pack, basemap = data / "packs" / f"{region.id}.fwr", data / "basemap" / f"{region.id}.pmtiles"
    cameras_src = data / "packs" / f"{region.id}.cameras.json"
    missing = [p.name for p in (pack, basemap) if not p.exists()]
    if missing:
        print(f"{region.id}: skipped, missing {', '.join(missing)} in {data}", file=sys.stderr)
        return None
    header = read_header(pack)
    pack_path, pack_sha, pack_bytes = stage_hashed(pack, out / "packs", region.id, ".fwr")
    base_path, base_sha, base_bytes = stage_hashed(basemap, out / "basemap", region.id, ".pmtiles")

    cameras_dst = out / "cameras" / f"{region.id}.json"
    if not cameras_dst.exists():  # a fresher feed from pipeline.refresh_cameras wins
        if not cameras_src.exists():
            raise FileNotFoundError(f"{region.id}: no camera feed; run `python -m pipeline.refresh_cameras --out {out}`")
        place(cameras_src, cameras_dst)

    w, s, e, n = header["bbox"]
    entry = {
        "id": region.id,
        "name": region.name,
        "bbox": [w, s, e, n],
        "center": [round((w + e) / 2, 5), round((s + n) / 2, 5)],
        "pack": {"path": pack_path, "bytes": pack_bytes, "sha256": pack_sha, "built_at": header["built_at"]},
        "basemap": {"path": base_path, "bytes": base_bytes, "sha256": base_sha},
        "cameras": {"path": f"cameras/{region.id}.json"},
    }
    if region.example:
        entry["example"] = {"from": list(region.example[0]), "to": list(region.example[1])}
    return entry


def stage_assets(data: Path, out: Path) -> None:
    src = data / "basemap" / "assets"
    if not src.exists():
        raise FileNotFoundError(f"{src} missing; run `npm run fetch-basemap -w @flockwatch/web`")
    dst = out / "basemap" / "assets"
    for f in src.rglob("*"):
        if f.is_file():
            place(f, dst / f.relative_to(src))


def stage_release(data: Path, out: Path, regions: list[Region]) -> dict:
    entries = [e for r in regions if (e := stage_region(r, data, out))]
    if not entries:
        raise RuntimeError("nothing to release: no region has both a road pack and a basemap in " + str(data))
    stage_assets(data, out)
    manifest = {
        "schema": SCHEMA,
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "assets": ASSETS,
        "regions": entries,
    }
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / "regions.json.tmp"
    tmp.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    tmp.replace(out / "regions.json")
    return manifest


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", type=Path, default=Path("data"))
    ap.add_argument("--out", type=Path, default=Path("release"))
    args = ap.parse_args(argv)
    manifest = stage_release(args.data, args.out, load_regions())
    for r in manifest["regions"]:
        print(f"{r['id']}: pack {r['pack']['bytes'] / 1e6:.1f} MB, basemap {r['basemap']['bytes'] / 1e6:.1f} MB "
              f"-> {args.out / r['pack']['path']}, {args.out / r['basemap']['path']}")
    print(f"wrote {args.out / 'regions.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
