"""Stage a release: the exact set of static files the web app loads.

Usage:
  python -m pipeline.release [--data data] [--out release]
      Everything that's built in data/: packs, basemaps, search indexes, fonts, cameras and
      regions.json.
  python -m pipeline.release --part NAME --region ID [--region ID ...] [--national]
      One build batch: stages those regions' packs, basemaps and search indexes and writes
      parts/NAME.json. With --national the regions get no basemaps of their own (see --basemap).
  python -m pipeline.release --basemap
      The basemap of the whole country (data/basemap/us.pmtiles, from fetch-basemap.mjs --us):
      stages it and writes parts/basemap.json.
  python -m pipeline.release --assemble [--live live.json]
      Merges every parts/*.json into regions.json. Regions that weren't rebuilt keep their entry
      from --live (the manifest that's online now), so rebuilding one city never drops the rest.

    release/
      regions.json                       what exists, where, and how big (short cache)
      packs/<id>.<hash>.fwr.gz           road pack, gzipped, content-hashed (cache forever)
      places/<id>.<hash>.fwp.gz          search index, gzipped, content-hashed (cache forever)
      basemap/us.<hash>.pmtiles          Protomaps extract of the lower 48, content-hashed (cache
                                         forever); or, before there was one, a basemap per area:
      basemap/<id>.<hash>.pmtiles
      basemap/assets/...                 label fonts and icon sprites (cache forever)
      cameras/<id>.json                  camera feed, rewritten hourly (revalidate)
      parts/<name>.json                  a build batch's entries; build-time only, never uploaded

The same tree is what gets uploaded to object storage (see docs/DEPLOY.md) and what the dev and
phone servers serve locally, so development runs the production layout. Hashed names mean a new
pack or basemap is just a new file plus a new manifest: nothing cached ever goes stale, and old
files stay valid for pages that are still open.

With a basemap of the whole country, the manifest names it once (`basemap`, with its bounds) and
every region's `basemap` is that same file, so an app from before reads it as its area's.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
import shutil
import struct
import sys
from pathlib import Path

from . import places as place_index
from .pack import read_header
from .regions import Region, load_regions

SCHEMA = 2
HASH_CHARS = 10
#: The basemap of the whole country: data/basemap/us.pmtiles, staged as basemap/us.<hash>.pmtiles.
NATIONAL = "us"
ASSETS = {
    "glyphs": "basemap/assets/fonts/{fontstack}/{range}.pbf",
    "sprite": "basemap/assets/sprites/v4/light",
    "sprite_dark": "basemap/assets/sprites/v4/dark",
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


def _hashed(src: Path, out_dir: Path, region_id: str, suffix: str) -> tuple[Path, str]:
    """Place `src` as <region>.<hash><suffix>, removing older versions; returns (target, sha)."""
    digest = sha256_of(src)
    target = out_dir / f"{region_id}.{digest[:HASH_CHARS]}{suffix}"
    if not target.exists():
        place(src, target)
    for old in out_dir.glob(f"{region_id}.*{suffix}"):
        if old != target:
            old.unlink()
    return target, digest


def gzip_pack(src: Path, dst: Path) -> None:
    """Deterministic gzip (no timestamp or name in the header), so an unchanged pack keeps its hash."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(dst.suffix + ".tmp")
    with open(src, "rb") as fin, open(tmp, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw,
                                                                        compresslevel=9, mtime=0) as fout:
        shutil.copyfileobj(fin, fout, 1 << 20)
    tmp.replace(dst)


def stage_places(region: Region, data: Path, out: Path, live: dict | None = None) -> dict | None:
    """The region's search index entry: the one built in data/places, or the live one when nothing
    was built (or what was built has the live one's fingerprint); None when there's neither."""
    src, live_entry = data / "places" / f"{region.id}.fwp", (live or {}).get("places")
    if not src.exists():
        return live_entry
    header = place_index.read_header(src)
    if live_entry and live_entry.get("fingerprint") == header["fingerprint"]:
        return live_entry
    gz = out / "places" / f"{region.id}.fwp.gz.tmp-src"
    gzip_pack(src, gz)
    path, sha = _hashed(gz, out / "places", region.id, ".fwp.gz")
    gz.unlink()
    return {
        "path": path.relative_to(out).as_posix(), "encoding": "gzip", "bytes": path.stat().st_size,
        "raw_bytes": src.stat().st_size, "sha256": sha, "built_at": header["built_at"],
        "fingerprint": header["fingerprint"], "counts": header["counts"],
        **({"osm_at": header["osm_at"]} if header.get("osm_at") else {}),
    }


def _pmtiles_header(path: Path) -> bytes | None:
    with open(path, "rb") as f:
        head = f.read(127)
    return head if head.startswith(b"PMTiles") and len(head) == 127 else None


def pmtiles_maxzoom(path: Path) -> int | None:
    head = _pmtiles_header(path)
    return head[101] if head else None


def pmtiles_bounds(path: Path) -> list[float] | None:
    """west, south, east, north from a PMTiles v3 header (degrees, stored as 1e-7 integers)."""
    head = _pmtiles_header(path)
    return [round(v / 1e7, 5) for v in struct.unpack_from("<iiii", head, 102)] if head else None


def stage_basemap(data: Path, out: Path) -> dict | None:
    """The whole country's basemap entry, if data/basemap/us.pmtiles was built (else None)."""
    src = data / "basemap" / f"{NATIONAL}.pmtiles"
    if not src.exists():
        return None
    path, sha = _hashed(src, out / "basemap", NATIONAL, ".pmtiles")
    return {
        "path": path.relative_to(out).as_posix(), "bytes": path.stat().st_size, "sha256": sha,
        "maxzoom": pmtiles_maxzoom(path), "bbox": pmtiles_bounds(path),
    }


def stage_region(region: Region, data: Path, out: Path, live: dict | None = None, national: bool = False) -> dict | None:
    """Stage one region's pack, basemap and search index; returns its manifest entry (None if
    there's nothing to list: a region needs a pack and a basemap; the search index is optional).
    With `national` it needs no basemap of its own: `assemble` gives it the country's.

    `live` is the region's entry in the published manifest. A part that wasn't rebuilt (the
    nightly update builds no basemaps, and leaves out packs it decided not to publish) keeps the
    live one, and a rebuilt pack with the live pack's fingerprint keeps the live file too, so
    phones don't download the same roads again.
    """
    pack, basemap = data / "packs" / f"{region.id}.fwr", data / "basemap" / f"{region.id}.pmtiles"
    live_pack, live_base = (live or {}).get("pack"), (live or {}).get("basemap")
    header = read_header(pack) if pack.exists() else None
    if header and not (live_pack and header.get("fingerprint") and live_pack.get("fingerprint") == header["fingerprint"]):
        gz = out / "packs" / f"{region.id}.fwr.gz.tmp-src"
        gzip_pack(pack, gz)
        pack_path, pack_sha = _hashed(gz, out / "packs", region.id, ".fwr.gz")
        gz.unlink()
        pack_entry = {
            "path": pack_path.relative_to(out).as_posix(), "encoding": "gzip", "bytes": pack_path.stat().st_size,
            "raw_bytes": pack.stat().st_size, "sha256": pack_sha, "built_at": header["built_at"],
            "edges": header["counts"]["edges"], "fingerprint": header.get("fingerprint"),
            **({"osm_at": header["osm_at"]} if header.get("osm_at") else {}),
        }
        w, s, e, n = header["bbox"]
    elif live_pack:
        pack_entry = live_pack
        w, s, e, n = live["bbox"]
    else:
        return None
    if basemap.exists() and not national:
        base_path, base_sha = _hashed(basemap, out / "basemap", region.id, ".pmtiles")
        base_entry = {
            "path": base_path.relative_to(out).as_posix(), "bytes": base_path.stat().st_size, "sha256": base_sha,
            "maxzoom": pmtiles_maxzoom(base_path),
        }
    elif live_base:
        base_entry = live_base
    elif national:
        base_entry = None
    else:
        return None

    entry = {
        "id": region.id,
        "name": region.name,
        "group": region.group,
        "states": region.states,
        "bbox": [w, s, e, n],
        "center": [round((w + e) / 2, 5), round((s + n) / 2, 5)],
        "pack": pack_entry,
        "basemap": base_entry,
        "cameras": {"path": f"cameras/{region.id}.json"},
    }
    if base_entry is None:
        del entry["basemap"]  # national: `assemble` gives it the country's
    places = stage_places(region, data, out, live)
    if places:
        entry["places"] = places
    if region.example:
        entry["example"] = {"from": list(region.example[0]), "to": list(region.example[1])}
    return entry


def stage_assets(data: Path, out: Path) -> None:
    src = data / "basemap" / "assets"
    if not src.exists():
        raise FileNotFoundError(f"{src} missing; run `npm run fetch-basemap -w @flockwatch/web -- --assets-only`")
    dst = out / "basemap" / "assets"
    for f in src.rglob("*"):
        if f.is_file():
            place(f, dst / f.relative_to(src))


def write_part(out: Path, name: str, entries: list[dict], basemap: dict | None = None) -> Path:
    path = out / "parts" / f"{name}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    part = {"part": name, "regions": entries, **({"basemap": basemap} if basemap else {})}
    path.write_text(json.dumps(part, indent=2) + "\n", encoding="utf-8")
    return path


def read_parts(out: Path) -> list[dict]:
    entries = []
    for f in sorted((out / "parts").glob("*.json")):
        entries += json.loads(f.read_text(encoding="utf-8"))["regions"]
    return entries


def read_basemap_part(out: Path) -> dict | None:
    """The country's basemap, if a part brought one (`--basemap`)."""
    for f in sorted((out / "parts").glob("*.json")):
        basemap = json.loads(f.read_text(encoding="utf-8")).get("basemap")
        if basemap:
            return basemap
    return None


def assemble(out: Path, regions: list[Region], fresh: list[dict], live: dict | None = None,
             basemap: dict | None = None) -> dict:
    """The manifest: fresh entries win, then the live ones; ordered as in regions.json.

    A region needs a camera feed in out/cameras to be listed (the app can't run without one), and
    a region that's no longer in regions.json is dropped. The country's basemap is `basemap` if
    one was just built, else the live manifest's; with one, every region's basemap is it, and
    without one a region needs a basemap of its own.
    """
    by_id = {e["id"]: e for e in (live or {}).get("regions", [])}
    reusable = bool(live) and live.get("schema") == SCHEMA
    if live and not reusable:
        print(f"the live manifest is schema {live.get('schema')}, not {SCHEMA}: not reusing its entries", file=sys.stderr)
        by_id = {}
    basemap = basemap or (live.get("basemap") if reusable else None)
    by_id.update({e["id"]: e for e in fresh})
    entries = []
    for r in regions:
        e = by_id.get(r.id)
        if e is None:
            continue
        if not (out / e["cameras"]["path"]).exists():
            print(f"{r.id}: left out, no camera feed at {out / e['cameras']['path']}", file=sys.stderr)
            continue
        if basemap:
            e = {**e, "basemap": basemap}
        elif not e.get("basemap"):
            print(f"{r.id}: left out, no basemap (and no basemap of the country)", file=sys.stderr)
            continue
        entries.append(e)
    if not entries:
        raise RuntimeError("nothing to release: no region has a road pack, a basemap and a camera feed")
    return {
        "schema": SCHEMA,
        "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "assets": asset_paths(out),
        **({"basemap": basemap} if basemap else {}),
        "regions": entries,
    }


def asset_paths(out: Path) -> dict:
    """The manifest's `assets`, the dark map's icons only once they're staged: an asset folder
    fetched before dark mode doesn't have them, and the app then uses the light ones."""
    if (out / f"{ASSETS['sprite_dark']}.json").exists():
        return ASSETS
    return {k: v for k, v in ASSETS.items() if k != "sprite_dark"}


def same_manifest(a: dict | None, b: dict | None) -> bool:
    """Whether two manifests list the same files (when they were generated aside)."""
    strip = lambda m: {k: v for k, v in (m or {}).items() if k != "generated_at"}  # noqa: E731
    return a is not None and b is not None and strip(a) == strip(b)


def write_manifest(out: Path, manifest: dict) -> None:
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / "regions.json.tmp"
    tmp.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    tmp.replace(out / "regions.json")


def stage_release(data: Path, out: Path, regions: list[Region]) -> dict:
    """Stage everything built in `data` (the local, all-in-one path): with the country's basemap
    if it's there, else each area's own."""
    basemap = stage_basemap(data, out)
    entries = [e for r in regions if (e := stage_region(r, data, out, national=bool(basemap)))]
    if not entries:
        raise RuntimeError("nothing to release: no region has both a road pack and a basemap in " + str(data))
    if len(entries) < len(regions):
        print(f"{len(regions) - len(entries)} of {len(regions)} regions aren't built in {data}; staging the other {len(entries)}")
    stage_assets(data, out)
    for e in entries:  # a fresher feed from pipeline.refresh_cameras wins
        feed, local = out / e["cameras"]["path"], data / "packs" / f"{e['id']}.cameras.json"
        if not feed.exists():
            if not local.exists():
                raise FileNotFoundError(f"{e['id']}: no camera feed; run `python -m pipeline.refresh_cameras --out {out}`")
            place(local, feed)
    manifest = assemble(out, regions, entries, basemap=basemap)
    write_manifest(out, manifest)
    return manifest


def _summary(manifest_or_entries) -> None:
    entries = manifest_or_entries["regions"] if isinstance(manifest_or_entries, dict) else manifest_or_entries
    for r in entries:
        search = f", search {r['places']['bytes'] / 1e6:.1f} MB" if r.get("places") else ", no search index"
        base = f", basemap {r['basemap']['bytes'] / 1e6:.1f} MB" if r.get("basemap") else ""
        print(f"{r['id']}: pack {r['pack']['bytes'] / 1e6:.1f} MB gzipped ({r['pack']['edges']:,} edges){base}{search}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", type=Path, default=Path("data"))
    ap.add_argument("--out", type=Path, default=Path("release"))
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--part", metavar="NAME", help="stage just --region ... and write parts/NAME.json")
    mode.add_argument("--assemble", action="store_true", help="merge parts/*.json (and --live) into regions.json")
    mode.add_argument("--basemap", action="store_true", help="stage the country's basemap and write parts/basemap.json")
    ap.add_argument("--region", action="append", default=[], help="with --part: a region id (repeatable)")
    ap.add_argument("--national", action="store_true",
                    help="with --part: the regions use the country's basemap, so they need none of their own")
    ap.add_argument("--live", type=Path, help="the manifest that's online now, if any: parts reuse its files "
                                               "for what wasn't rebuilt, and --assemble keeps its other regions")
    ap.add_argument("--changed-flag", type=Path,
                    help="with --assemble: write true or false here, whether the manifest differs from --live")
    args = ap.parse_args(argv)
    regions = load_regions()
    live = json.loads(args.live.read_text(encoding="utf-8")) if args.live and args.live.exists() else None
    live_by_id = {e["id"]: e for e in (live or {}).get("regions", [])} if (live or {}).get("schema") == SCHEMA else {}

    if args.basemap:
        basemap = stage_basemap(args.data, args.out)
        if not basemap:
            raise FileNotFoundError(f"no {args.data / 'basemap' / f'{NATIONAL}.pmtiles'}; run fetch-basemap.mjs --us")
        path = write_part(args.out, "basemap", [], basemap=basemap)
        print(f"{basemap['path']}: {basemap['bytes'] / 1e9:.1f} GB, zoom {basemap['maxzoom']}, bounds {basemap['bbox']}; wrote {path}")
        return 0
    if args.part:
        wanted = set(args.region)
        entries = [e for r in regions if r.id in wanted
                   and (e := stage_region(r, args.data, args.out, live_by_id.get(r.id), national=args.national))]
        missing = sorted(wanted - {e["id"] for e in entries})
        if missing:
            print(f"not built, so not staged: {', '.join(missing)}", file=sys.stderr)
        path = write_part(args.out, args.part, entries)
        _summary(entries)
        print(f"wrote {path} ({len(entries)} of {len(wanted)} regions)")
        return 0
    if args.assemble:
        if (args.data / "basemap" / "assets").exists():
            stage_assets(args.data, args.out)
        manifest = assemble(args.out, regions, read_parts(args.out), live, basemap=read_basemap_part(args.out))
        changed = not same_manifest(manifest, live)
        if not changed:
            manifest = live  # keep its date: nothing new to announce
        write_manifest(args.out, manifest)
        if args.changed_flag:
            args.changed_flag.write_text("true" if changed else "false", encoding="utf-8")
        print(f"wrote {args.out / 'regions.json'}: {len(manifest['regions'])} regions"
              + ("" if changed else ", the same as what's online"))
        return 0
    manifest = stage_release(args.data, args.out, regions)
    _summary(manifest)
    print(f"wrote {args.out / 'regions.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
