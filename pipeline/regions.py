"""The regions AvoiDLPR covers (pipeline/regions.json).

Each region is one metro-sized area with its own road pack, basemap extract and camera feed.
Adding a city is a data change: add an entry here, then build and publish it (see
docs/DEVELOPING.md).

A region lists every Geofabrik extract it needs (`geofabrik`): Charlotte reaches into South
Carolina, so it names both states, and the build merges them. `python -m pipeline.check_regions`
checks those lists against the states' real boundaries.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

CONFIG = Path(__file__).with_name("regions.json")
GEOFABRIK = "https://download.geofabrik.de"
US = "north-america/us/"

#: Geofabrik's US state extracts: slug -> (postal code, name, build batch). A batch is a group of
#: neighbouring states whose regions are built together, so each state is downloaded once per
#: batch; the monthly build runs the batches in parallel (pipeline/plan.py).
US_STATES: dict[str, tuple[str, str, str]] = {
    "alabama": ("AL", "Alabama", "southeast"),
    "alaska": ("AK", "Alaska", "west"),
    "arizona": ("AZ", "Arizona", "west"),
    "arkansas": ("AR", "Arkansas", "south-central"),
    "california": ("CA", "California", "california"),
    "colorado": ("CO", "Colorado", "west"),
    "connecticut": ("CT", "Connecticut", "northeast"),
    "delaware": ("DE", "Delaware", "mid-atlantic"),
    "district-of-columbia": ("DC", "District of Columbia", "mid-atlantic"),
    "florida": ("FL", "Florida", "florida"),
    "georgia": ("GA", "Georgia", "southeast"),
    "hawaii": ("HI", "Hawaii", "west"),
    "idaho": ("ID", "Idaho", "west"),
    "illinois": ("IL", "Illinois", "great-lakes"),
    "indiana": ("IN", "Indiana", "ohio-valley"),
    "iowa": ("IA", "Iowa", "plains"),
    "kansas": ("KS", "Kansas", "plains"),
    "kentucky": ("KY", "Kentucky", "ohio-valley"),
    "louisiana": ("LA", "Louisiana", "south-central"),
    "maine": ("ME", "Maine", "northeast"),
    "maryland": ("MD", "Maryland", "mid-atlantic"),
    "massachusetts": ("MA", "Massachusetts", "northeast"),
    "michigan": ("MI", "Michigan", "great-lakes"),
    "minnesota": ("MN", "Minnesota", "great-lakes"),
    "mississippi": ("MS", "Mississippi", "southeast"),
    "missouri": ("MO", "Missouri", "plains"),
    "montana": ("MT", "Montana", "west"),
    "nebraska": ("NE", "Nebraska", "plains"),
    "nevada": ("NV", "Nevada", "west"),
    "new-hampshire": ("NH", "New Hampshire", "northeast"),
    "new-jersey": ("NJ", "New Jersey", "northeast"),
    "new-mexico": ("NM", "New Mexico", "south-central"),
    "new-york": ("NY", "New York", "northeast"),
    "north-carolina": ("NC", "North Carolina", "southeast"),
    "north-dakota": ("ND", "North Dakota", "plains"),
    "ohio": ("OH", "Ohio", "ohio-valley"),
    "oklahoma": ("OK", "Oklahoma", "south-central"),
    "oregon": ("OR", "Oregon", "west"),
    "pennsylvania": ("PA", "Pennsylvania", "mid-atlantic"),
    "rhode-island": ("RI", "Rhode Island", "northeast"),
    "south-carolina": ("SC", "South Carolina", "southeast"),
    "south-dakota": ("SD", "South Dakota", "plains"),
    "tennessee": ("TN", "Tennessee", "southeast"),
    "texas": ("TX", "Texas", "south-central"),
    "utah": ("UT", "Utah", "west"),
    "vermont": ("VT", "Vermont", "northeast"),
    "virginia": ("VA", "Virginia", "mid-atlantic"),
    "washington": ("WA", "Washington", "west"),
    "west-virginia": ("WV", "West Virginia", "mid-atlantic"),
    "wisconsin": ("WI", "Wisconsin", "great-lakes"),
    "wyoming": ("WY", "Wyoming", "west"),
}


@dataclass(frozen=True)
class Region:
    id: str
    name: str
    #: lon/lat rectangle (west, south, east, north) cut out of the source extracts.
    clip_bbox: tuple[float, float, float, float]
    #: Geofabrik paths of the extracts that contain it, e.g. ("north-america/us/texas",). The
    #: first one is its home: it decides how the region is grouped in the app and in the build.
    geofabrik: tuple[str, ...]
    #: Optional showcase trip ((lon, lat) start, (lon, lat) end) for the app's "example" button.
    example: tuple[tuple[float, float], tuple[float, float]] | None = None

    @property
    def geofabrik_urls(self) -> list[str]:
        return [geofabrik_url(g) for g in self.geofabrik]

    @property
    def states(self) -> list[str]:
        """Postal codes of the US states it spans, home state first ([] outside the US)."""
        return [US_STATES[g.removeprefix(US)][0] for g in self.geofabrik if g.removeprefix(US) in US_STATES]

    @property
    def group(self) -> str:
        """What the app files it under: the home state's name (or the extract's own name)."""
        home = self.geofabrik[0].removeprefix(US)
        return US_STATES[home][1] if home in US_STATES else home.rsplit("/", 1)[-1].replace("-", " ").title()

    @property
    def batch(self) -> str:
        """Which group of the monthly build makes it (see US_STATES)."""
        home = self.geofabrik[0].removeprefix(US)
        return US_STATES[home][2] if home in US_STATES else "other"


def geofabrik_url(path: str) -> str:
    return f"{GEOFABRIK}/{path}-latest.osm.pbf"


def _region(r: dict) -> Region:
    sources = r["geofabrik"]
    return Region(
        r["id"], r["name"], tuple(r["clip_bbox"]), (sources,) if isinstance(sources, str) else tuple(sources),
        (tuple(r["example"]["from"]), tuple(r["example"]["to"])) if r.get("example") else None,
    )


def load_regions(path: Path = CONFIG) -> list[Region]:
    regions = [_region(r) for r in json.loads(path.read_text(encoding="utf-8"))["regions"]]
    ids = [r.id for r in regions]
    if len(ids) != len(set(ids)):
        raise ValueError(f"{path}: duplicate region ids: {sorted({i for i in ids if ids.count(i) > 1})}")
    for r in regions:
        w, s, e, n = r.clip_bbox
        if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
            raise ValueError(f"{path}: region {r.id!r} has an invalid clip_bbox {r.clip_bbox}")
        if not r.geofabrik or len(set(r.geofabrik)) != len(r.geofabrik):
            raise ValueError(f"{path}: region {r.id!r} needs one or more distinct geofabrik extracts")
        if not r.id.replace("-", "").isalnum() or r.id != r.id.lower():
            raise ValueError(f"{path}: region id {r.id!r} must be lowercase letters, digits and hyphens")
    return regions


def get_region(region_id: str, path: Path = CONFIG) -> Region:
    for r in load_regions(path):
        if r.id == region_id:
            return r
    raise KeyError(f"no region {region_id!r} in {path}")
