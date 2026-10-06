"""Which files in the bucket nothing points at any more: superseded road packs, basemaps and
search indexes.

Usage: python -m pipeline.prune --manifest regions.json [--previous regions.prev.json]
                                --listing listing.txt [--min-age-hours 24]

Reads the live manifest, the one it replaced (the publish step keeps it as regions.prev.json),
and a listing of the bucket's objects under packs/, basemap/ and places/, one per line as
`<key>\\t<last modified>` (what `aws s3api list-objects-v2 --query
'Contents[].[Key,LastModified]' --output text` prints), and prints the keys to delete.

A file stays while the live manifest names it, and for --min-age-hours after a publish while the
previous manifest names it (a page that loaded that one may still fetch its files). A file
younger than that stays too, named or not: a build uploads its new files before it publishes the
manifest that names them. A line without a timestamp counts as new. Fonts and sprites
(basemap/assets/), and anything outside packs/, basemap/ and places/, are never touched.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

PRUNABLE = ("packs/", "basemap/", "places/")
NEVER = ("basemap/assets/",)


def parse_listing(text: str) -> dict[str, dt.datetime | None]:
    """`key<whitespace>timestamp` lines -> {key: last modified (None when it's missing)}."""
    objects: dict[str, dt.datetime | None] = {}
    for line in text.splitlines():
        parts = line.split()
        if not parts or parts[0] == "None":
            continue
        when = None
        if len(parts) > 1:
            try:
                when = dt.datetime.fromisoformat(parts[1].replace("Z", "+00:00"))
            except ValueError:
                when = None
        objects[parts[0]] = when
    return objects


def _paths(manifest: dict) -> set[str]:
    return {path for r in manifest.get("regions", [])
            for path in (r["pack"]["path"], r["basemap"]["path"], (r.get("places") or {}).get("path")) if path}


def stale_keys(manifest: dict, objects: dict[str, dt.datetime | None], *, now: dt.datetime, min_age_hours: float,
               previous: dict | None = None) -> list[str]:
    age = dt.timedelta(hours=min_age_hours)
    keep = _paths(manifest)
    if previous and now - dt.datetime.fromisoformat(manifest["generated_at"]) < age:
        keep |= _paths(previous)  # the previous manifest's files get a day's grace after the switch
    return sorted(
        k for k, when in objects.items()
        if k.startswith(PRUNABLE) and not k.startswith(NEVER) and not k.endswith("/") and k not in keep
        and when is not None and now - when >= age
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--manifest", type=Path, required=True)
    ap.add_argument("--previous", type=Path, help="the manifest the live one replaced, if it's there")
    ap.add_argument("--listing", type=Path, required=True)
    ap.add_argument("--min-age-hours", type=float, default=24)
    args = ap.parse_args(argv)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    previous = json.loads(args.previous.read_text(encoding="utf-8")) if args.previous and args.previous.exists() else None
    objects = parse_listing(args.listing.read_text(encoding="utf-8"))
    for k in stale_keys(manifest, objects, now=dt.datetime.now(dt.UTC), min_age_hours=args.min_age_hours,
                        previous=previous):
        print(k)
    return 0


if __name__ == "__main__":
    sys.exit(main())
