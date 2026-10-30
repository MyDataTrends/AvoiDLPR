"""Merge OSM files into one, keeping only the newest version of each node, way and relation.

Usage: python -m pipeline.merge <in.osm.pbf> [<in.osm.pbf> ...] -o <out.osm.pbf>

A batch's states are merged before its areas are cut out. A road that crosses a state line is in
both states' files, and in the nightly update each state is rolled forward on its own, so the two
copies can be different versions of the same way. `osmium merge` keeps both, and every
`osmium extract` after it then fails ("Way ID twice in input"). Keeping the newest version of each
object is what the merged map should say anyway.
"""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path

import osmium


def merge_newest(sources: Sequence[Path], target: Path) -> None:
    reader = osmium.MergeInputReader()
    for source in sources:
        reader.add_file(str(source))
    target = Path(target)
    target.unlink(missing_ok=True)  # the writer won't overwrite
    writer = osmium.SimpleWriter(str(target))
    try:
        reader.apply(writer, simplify=True)  # simplify: the newest version of each object only
    finally:
        writer.close()


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("sources", nargs="+", type=Path)
    ap.add_argument("-o", "--output", type=Path, required=True)
    args = ap.parse_args(argv)
    merge_newest(args.sources, args.output)


if __name__ == "__main__":
    main()
