"""Build a compressed, directed drive graph from an OSM PBF.

Ways are split at intersections (nodes used more than once across ways) and at way ends,
so each graph edge is one intersection-to-intersection polyline. Writes
data/<stem>.graph.npz next to the input.

Usage: python build_graph.py data/Dallas.osm.pbf
"""

from __future__ import annotations

import re
import sys
import time
from pathlib import Path

import numpy as np
import osmium

from geometry import LocalProjection

# Free-flow car speeds (km/h) for ways without a usable maxspeed. No turn or signal
# delays are modelled, so absolute times run optimistic; ratios between routes are what
# the spike compares.
DEFAULT_KMH = {
    "motorway": 105, "motorway_link": 60, "trunk": 90, "trunk_link": 50,
    "primary": 65, "primary_link": 45, "secondary": 55, "secondary_link": 40,
    "tertiary": 45, "tertiary_link": 35, "unclassified": 40, "residential": 30,
    "living_street": 15, "service": 20,
}
HIGHWAY_CODE = {k: i for i, k in enumerate(DEFAULT_KMH)}
# Parking aisles and driveways would let routes cut through retail lots, which is both
# unrealistic and exactly where retail-operated ALPRs sit.
SKIP_SERVICE = {"parking_aisle", "driveway", "drive-through", "emergency_access"}
NO_ACCESS = {"no", "private", "agricultural", "forestry"}
_MAXSPEED = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(mph)?\s*$")


def parse_maxspeed(value: str | None) -> float | None:
    m = _MAXSPEED.match(value or "")
    if not m:
        return None
    kmh = float(m[1]) * (1.609344 if m[2] else 1.0)
    return kmh if 5 <= kmh <= 140 else None


def drivable_highway(tags: dict) -> str | None:
    hw = tags.get("highway")
    if hw not in DEFAULT_KMH or tags.get("area") == "yes":
        return None
    if hw == "service" and tags.get("service") in SKIP_SERVICE:
        return None
    for key in ("motorcar", "motor_vehicle", "vehicle", "access"):  # most specific wins
        if key in tags:
            return None if tags[key] in NO_ACCESS else hw
    return hw


def travel_directions(tags: dict, hw: str) -> tuple[bool, bool]:
    oneway = tags.get("oneway", "")
    if oneway in ("-1", "reverse"):
        return False, True
    if oneway in ("yes", "true", "1") or tags.get("junction") in ("roundabout", "circular"):
        return True, False
    if hw in ("motorway", "motorway_link") and oneway != "no":
        return True, False
    return True, True


class WayCollector(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.refs: list[np.ndarray] = []
        self.lonlat: list[np.ndarray] = []
        self.attrs: list[tuple[int, float, bool, bool, int]] = []
        self.skipped_incomplete = 0

    def way(self, w):
        tags = {t.k: t.v for t in w.tags}
        hw = drivable_highway(tags)
        if hw is None or len(w.nodes) < 2:
            return
        if not all(n.location.valid() for n in w.nodes):
            self.skipped_incomplete += 1  # crosses the extract boundary
            return
        fwd, rev = travel_directions(tags, hw)
        kmh = parse_maxspeed(tags.get("maxspeed")) or DEFAULT_KMH[hw]
        self.refs.append(np.fromiter((n.ref for n in w.nodes), np.int64, len(w.nodes)))
        self.lonlat.append(np.array([(n.location.lon, n.location.lat) for n in w.nodes]))
        self.attrs.append((HIGHWAY_CODE[hw], kmh, fwd, rev, w.id))


def build(pbf: Path) -> Path:
    t0 = time.perf_counter()
    h = WayCollector()
    h.apply_file(str(pbf), locations=True)
    print(f"ways: {len(h.refs):,} drivable ({h.skipped_incomplete} cut by extract boundary)"
          f"  [{time.perf_counter() - t0:.1f}s]")

    all_refs = np.concatenate(h.refs)
    uniq, counts = np.unique(all_refs, return_counts=True)
    shared = counts[np.searchsorted(uniq, all_refs)] > 1
    way_off = np.concatenate([[0], np.cumsum([len(r) for r in h.refs])])
    shared[way_off[:-1]] = True  # way ends always split
    shared[way_off[1:] - 1] = True

    node_refs = np.unique(all_refs[shared])
    node_of = {int(r): i for i, r in enumerate(node_refs)}
    node_lonlat = np.zeros((len(node_refs), 2))

    geom_pts: list[np.ndarray] = []
    rows: list[tuple] = []
    for wi, (refs, ll) in enumerate(zip(h.refs, h.lonlat, strict=True)):
        cuts = np.flatnonzero(shared[way_off[wi]:way_off[wi + 1]])
        for i, j in zip(cuts[:-1], cuts[1:], strict=True):
            u, v = node_of[int(refs[i])], node_of[int(refs[j])]
            node_lonlat[u], node_lonlat[v] = ll[i], ll[j]
            geom_pts.append(ll[i:j + 1])
            rows.append((u, v, *h.attrs[wi]))

    lon_min, lat_min = node_lonlat.min(axis=0)
    lon_max, lat_max = node_lonlat.max(axis=0)
    proj = LocalProjection((lat_min + lat_max) / 2, (lon_min + lon_max) / 2)

    geom_lonlat = np.concatenate(geom_pts)
    gx, gy = proj.to_xy(geom_lonlat[:, 0], geom_lonlat[:, 1])
    geom_xy = np.column_stack([gx, gy])
    offsets = np.concatenate([[0], np.cumsum([len(p) for p in geom_pts])])
    seg = np.hypot(*np.diff(geom_xy, axis=0).T)
    seg[offsets[1:-1] - 1] = 0.0  # zero the fake segments joining consecutive geometries
    geom_len = np.add.reduceat(np.append(seg, 0.0), offsets[:-1])

    nx, ny = proj.to_xy(node_lonlat[:, 0], node_lonlat[:, 1])
    cols = list(zip(*rows, strict=True))
    out = pbf.with_name(pbf.name.split(".")[0] + ".graph.npz")
    np.savez_compressed(
        out,
        lat0=proj.lat0, lon0=proj.lon0,
        node_lonlat=node_lonlat, node_xy=np.column_stack([nx, ny]),
        geom_offsets=offsets, geom_xy=geom_xy, geom_len=geom_len,
        geom_u=np.array(cols[0], np.int64), geom_v=np.array(cols[1], np.int64),
        geom_hw=np.array(cols[2], np.int8), geom_kmh=np.array(cols[3], np.float64),
        geom_fwd=np.array(cols[4], bool), geom_rev=np.array(cols[5], bool),
        geom_way=np.array(cols[6], np.int64),
    )
    n_dir = int(np.sum(cols[4]) + np.sum(cols[5]))
    print(f"nodes: {len(node_refs):,}  geometries: {len(rows):,}  directed edges: {n_dir:,}"
          f"  road length: {geom_len.sum() / 1000:,.0f} km  [{time.perf_counter() - t0:.1f}s]")
    print(f"wrote {out}")
    return out


if __name__ == "__main__":
    build(Path(sys.argv[1] if len(sys.argv) > 1 else "data/Dallas.osm.pbf"))
