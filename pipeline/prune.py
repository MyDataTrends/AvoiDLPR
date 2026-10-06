"""Which files in the bucket nothing points at any more: superseded road packs and basemaps.

Usage: python -m pipeline.prune --manifest regions.json --listing listing.txt [--min-age-hours 24]

Reads the live manifest and a listing of the bucket's objects under packs/ and basemap/, one per
line as `<key>\\t<last modified>` (what `aws s3api list-objects-v2 --query
'Contents[].[Key,LastModified]' --output text` prints), and prints the keys to delete.

A file is deleted only when the manifest doesn't name it, the manifest has been live for
--min-age-hours (so a page that loaded the previous manifest can still fetch what it was told
about), and the file itself is at least that old: a build uploads its new files before it
publishes the manifest that names them, and those must survive a cleanup that runs in between.
A line without a timestamp counts as new. Fonts and sprites (basemap/assets/), and anything
outside packs/ and basemap/, are never touched.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

PRUNABLE = ("packs/", "basemap/")
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


def stale_keys(manifest: dict, objects: dict[str, dt.datetime | None], *, now: dt.datetime,
               min_age_hours: float) -> list[str]:
    age = dt.timedelta(hours=min_age_hours)
    if now - dt.datetime.fromisoformat(manifest["generated_at"]) < age:
        return []
    live = {path for r in manifest["regions"] for path in (r["pack"]["path"], r["basemap"]["path"])}
    return sorted(
        k for k, when in objects.items()
        if k.startswith(PRUNABLE) and not k.startswith(NEVER) and not k.endswith("/") and k not in live
        and when is not None and now - when >= age
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--manifest", type=Path, required=True)
    ap.add_argument("--listing", type=Path, required=True)
    ap.add_argument("--min-age-hours", type=float, default=24)
    args = ap.parse_args(argv)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    objects = parse_listing(args.listing.read_text(encoding="utf-8"))
    for k in stale_keys(manifest, objects, now=dt.datetime.now(dt.UTC), min_age_hours=args.min_age_hours):
        print(k)
    return 0


if __name__ == "__main__":
    sys.exit(main())
