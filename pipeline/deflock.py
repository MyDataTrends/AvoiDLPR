"""Camera locations from DeFlock's published region tiles.

DeFlock regenerates a worldwide ALPR dataset from OpenStreetMap every hour and publishes it as
static JSON tiles on a 20 degree grid: https://cdn.deflock.me/regions/{lat}/{lon}.json, where
`regions/index.json` lists the tiles that exist. A tile is a JSON array of
`{id, lat, lon, tags: {...}}` records (the id is the OSM node id).
"""

from __future__ import annotations

import json
import math
import time
import urllib.error
import urllib.request
from collections.abc import Callable

CDN = "https://cdn.deflock.me/regions"
TILE_DEG = 20
USER_AGENT = "flockwatch-pipeline/0.1 (+https://github.com/flockwatch)"

Fetch = Callable[[str], bytes | None]


def http_get(url: str, *, attempts: int = 4, timeout: float = 60.0) -> bytes | None:
    """GET `url`; None when it doesn't exist (403/404: DeFlock publishes no tile for empty areas)."""
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return None
            if attempt == attempts:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == attempts:
                raise
        time.sleep(2 * attempt)
    return None


def tile_origins(bbox: tuple[float, float, float, float]) -> list[tuple[int, int]]:
    """(lat, lon) south-west corners of the 20-degree tiles that intersect a bbox."""
    w, s, e, n = bbox
    lats = range(math.floor(s / TILE_DEG) * TILE_DEG, math.floor(n / TILE_DEG) * TILE_DEG + 1, TILE_DEG)
    lons = range(math.floor(w / TILE_DEG) * TILE_DEG, math.floor(e / TILE_DEG) * TILE_DEG + 1, TILE_DEG)
    return [(la, lo) for la in lats for lo in lons]


def fetch_cameras(bbox: tuple[float, float, float, float], *, margin_deg: float = 0.003,
                  fetch: Fetch = http_get) -> list[dict]:
    """Every camera inside `bbox` (plus a small margin), de-duplicated and sorted by OSM id."""
    w, s, e, n = bbox
    found: dict[int, dict] = {}
    for lat, lon in tile_origins(bbox):
        raw = fetch(f"{CDN}/{lat}/{lon}.json")
        if raw is None:
            continue
        tile = json.loads(raw)
        if not isinstance(tile, list):
            raise ValueError(f"{CDN}/{lat}/{lon}.json: expected a JSON array of cameras")
        for r in tile:
            if w - margin_deg <= r["lon"] <= e + margin_deg and s - margin_deg <= r["lat"] <= n + margin_deg:
                found[r["id"]] = {"id": r["id"], "lat": r["lat"], "lon": r["lon"], "tags": r.get("tags", {})}
    return [found[k] for k in sorted(found)]
