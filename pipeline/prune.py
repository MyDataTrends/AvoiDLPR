"""Which files in the bucket nothing points at any more: superseded road packs and basemaps.

Usage: python -m pipeline.prune --manifest regions.json --keys keys.txt [--min-age-hours 24]

Reads the live manifest and a listing of the bucket's keys under packs/ and basemap/ (any
whitespace-separated list, such as `aws s3api list-objects-v2 --query 'Contents[].Key' --output
text` prints) and prints the keys to delete: content-hashed files the manifest doesn't name. Until
the manifest is --min-age-hours old it prints nothing, so a page that loaded the previous manifest
just before an update can still fetch the files it was told about. Fonts and sprites
(basemap/assets/) and anything else outside packs/ and basemap/ are never touched.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

PRUNABLE = ("packs/", "basemap/")
NEVER = ("basemap/assets/",)


def stale_keys(manifest: dict, keys: list[str], *, now: dt.datetime, min_age_hours: float) -> list[str]:
    generated = dt.datetime.fromisoformat(manifest["generated_at"])
    if now - generated < dt.timedelta(hours=min_age_hours):
        return []
    live = {path for r in manifest["regions"] for path in (r["pack"]["path"], r["basemap"]["path"])}
    return sorted(k for k in set(keys)
                  if k.startswith(PRUNABLE) and not k.startswith(NEVER) and k not in live and not k.endswith("/"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--manifest", type=Path, required=True)
    ap.add_argument("--keys", type=Path, required=True)
    ap.add_argument("--min-age-hours", type=float, default=24)
    args = ap.parse_args(argv)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    keys = [k for k in args.keys.read_text(encoding="utf-8").split() if k != "None"]
    for k in stale_keys(manifest, keys, now=dt.datetime.now(dt.UTC), min_age_hours=args.min_age_hours):
        print(k)
    return 0


if __name__ == "__main__":
    sys.exit(main())
