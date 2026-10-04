"""The regions FlockWatch covers (pipeline/regions.json).

Each region is one metro-sized area with its own road pack, basemap extract and camera feed.
Adding a city is a data change: add an entry here, then build and publish it (see docs/DEPLOY.md).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

CONFIG = Path(__file__).with_name("regions.json")


@dataclass(frozen=True)
class Region:
    id: str
    name: str
    #: lon/lat rectangle (west, south, east, north) cut out of the source extract.
    clip_bbox: tuple[float, float, float, float]
    #: Geofabrik path of the regional OSM extract that contains it, e.g. "north-america/us/texas".
    geofabrik: str
    #: Optional showcase trip ((lon, lat) start, (lon, lat) end) for the app's "example" button.
    example: tuple[tuple[float, float], tuple[float, float]] | None = None

    @property
    def geofabrik_url(self) -> str:
        return f"https://download.geofabrik.de/{self.geofabrik}-latest.osm.pbf"


def load_regions(path: Path = CONFIG) -> list[Region]:
    raw = json.loads(path.read_text(encoding="utf-8"))["regions"]
    regions = [
        Region(r["id"], r["name"], tuple(r["clip_bbox"]), r["geofabrik"],
               (tuple(r["example"]["from"]), tuple(r["example"]["to"])) if r.get("example") else None)
        for r in raw
    ]
    ids = [r.id for r in regions]
    if len(ids) != len(set(ids)):
        raise ValueError(f"{path}: duplicate region ids")
    for r in regions:
        w, s, e, n = r.clip_bbox
        if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
            raise ValueError(f"{path}: region {r.id!r} has an invalid clip_bbox {r.clip_bbox}")
    return regions


def get_region(region_id: str, path: Path = CONFIG) -> Region:
    for r in load_regions(path):
        if r.id == region_id:
            return r
    raise KeyError(f"no region {region_id!r} in {path}")
