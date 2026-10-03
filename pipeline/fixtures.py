"""Regenerate the fixtures shared by the pipeline and the TypeScript router.

Committed (small, synthetic):
  packages/router/test/fixtures/grid.osm, grid.fwr, grid.json
      5x5 street grid (200 m blocks) with a one-way row, a turn restriction, a traffic
      signal, a dead-end stub, a footway and a disconnected way.
  packages/router/test/fixtures/reference_cases.json
      sector distances, captures and direction parsing from the spike's Python reference
      (spike/routing/geometry.py), so the TypeScript port stays in lockstep.
Local only (derived from the Dallas extract, under the gitignored data/):
  data/fixtures/dallas_exposure.json  per-edge capture sites from spike/routing/exposure.py
  data/fixtures/dallas_trips.json     the spike's 300 benchmark trips as lon/lat pairs

Usage: python -m pipeline.fixtures [--dallas]
"""

from __future__ import annotations

import argparse
import importlib
import json
import math
import sys
from pathlib import Path

import numpy as np

from .osm_graph import EARTH_RADIUS_M, build_graph
from .pack import decode_vertices, pack_meta, pack_sections, read_pack, write_pack

ROOT = Path(__file__).resolve().parents[1]
TS_FIXTURES = ROOT / "packages" / "router" / "test" / "fixtures"
DATA = ROOT / "data"
SPIKE = ROOT / "spike" / "routing"

GRID_LAT0, GRID_LON0, BLOCK_M = 32.78, -96.80, 200.0


def _spike(name: str):
    """Import a module from the routing spike: the reference implementation."""
    if str(SPIKE) not in sys.path:
        sys.path.insert(0, str(SPIKE))
    return importlib.import_module(name)


def grid_node_id(r: int, c: int) -> int:
    return 1 + 5 * r + c


def grid_nodes() -> dict[int, tuple[float, float]]:
    """id -> (lon, lat). Rows r run south to north, columns c west to east."""
    dlat = BLOCK_M / (math.radians(1.0) * EARTH_RADIUS_M)
    dlon = dlat / math.cos(math.radians(GRID_LAT0))
    nodes = {grid_node_id(r, c): (round(GRID_LON0 + (c - 2) * dlon, 7), round(GRID_LAT0 + (r - 2) * dlat, 7))
             for r in range(5) for c in range(5)}
    nodes[60] = (round(GRID_LON0 + 2.5 * dlon, 7), nodes[25][1])  # dead-end stub east of 25
    nodes[70] = (round(GRID_LON0 + 9 * dlon, 7), nodes[5][1])  # disconnected way, far east
    nodes[71] = (round(GRID_LON0 + 10 * dlon, 7), nodes[5][1])
    return nodes


def grid_osm() -> str:
    nodes = grid_nodes()
    row = lambda r, cs: [grid_node_id(r, c) for c in cs]  # noqa: E731
    col = lambda c, rs: [grid_node_id(r, c) for r in rs]  # noqa: E731
    res = {"highway": "residential"}
    ways = {
        100: (row(0, range(5)), res), 101: (row(1, range(5)), {**res, "oneway": "yes"}),
        102: (row(2, range(5)), res), 1030: (row(3, [0, 1]), res), 1031: (row(3, [1, 2, 3, 4]), res),
        104: (row(4, range(5)), res),
        200: (col(0, range(5)), res), 2010: (col(1, [0, 1, 2, 3]), res), 2011: (col(1, [3, 4]), res),
        202: (col(2, range(5)), res), 203: (col(3, range(5)), res), 204: (col(4, range(5)), res),
        500: ([25, 60], res), 300: ([70, 71], res), 400: ([13, 19], {"highway": "footway"}),
    }
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6" generator="flockwatch-fixtures">']
    for nid, (lon, lat) in nodes.items():
        tag = '<tag k="highway" v="traffic_signals"/>' if nid == 14 else ""
        out.append(f'  <node id="{nid}" version="1" lat="{lat}" lon="{lon}">{tag}</node>')
    for wid, (refs, tags) in ways.items():
        nds = "".join(f'<nd ref="{n}"/>' for n in refs)
        tg = "".join(f'<tag k="{k}" v="{v}"/>' for k, v in tags.items())
        out.append(f'  <way id="{wid}" version="1">{nds}{tg}</way>')
    out.append('  <relation id="900" version="1"><member type="way" ref="2010" role="from"/>'
               '<member type="node" ref="17" role="via"/><member type="way" ref="1031" role="to"/>'
               '<tag k="type" v="restriction"/><tag k="restriction" v="no_right_turn"/></relation>')
    out.append("</osm>")
    return "\n".join(out) + "\n"


def write_grid() -> None:
    TS_FIXTURES.mkdir(parents=True, exist_ok=True)
    osm = TS_FIXTURES / "grid.osm"
    osm.write_text(grid_osm())
    g = build_graph(osm)
    write_pack(TS_FIXTURES / "grid.fwr", pack_meta(g, osm.name, "fixture"), pack_sections(g))
    (TS_FIXTURES / "grid.json").write_text(json.dumps({
        "note": "OSM node id -> [lon, lat]; node id = 1 + 5*row + col, rows south->north",
        "nodes": {str(k): v for k, v in grid_nodes().items()},
    }, indent=1))
    print(f"grid: {g.n_nodes} nodes, {len(g.edge_src)} edges, {len(g.ban_from)} bans")


def write_reference_cases() -> None:
    geo = _spike("geometry")
    rng = np.random.default_rng(42)

    def rnd(v) -> float:  # short inputs keep the file small; expectations are computed on them
        return round(float(v), 3)

    sector = []
    for _ in range(3000):
        half = float(rng.choice([5, 15, 30, 45, 89.9, 90, 120, 179.5, 180]))
        r = rnd(rng.uniform(10, 120))
        b = rnd(rng.uniform(0, 360))
        px, py = (rnd(v) for v in rng.uniform(-3 * r, 3 * r, 2))
        sector.append([px, py, b, half, r, float(geo.sector_distance(px, py, b, half, r))])
    captures = []
    for _ in range(3000):
        name = str(rng.choice(list(geo.PROFILES)))
        p = geo.PROFILES[name]
        mode = str(rng.choice(["rear", "axis", "any"]))
        sectors = [(rnd(rng.uniform(0, 360)), float(rng.choice([p.half_angle, p.half_angle + 20, 180.0])))
                   for _ in range(int(rng.integers(1, 3)))]
        cam = geo.Camera(1, 0.0, 0.0, mode, tuple(sectors), "")
        x, y = (rnd(v) for v in rng.uniform(-1.5 * (p.range_m + p.eps_m), 1.5 * (p.range_m + p.eps_m), 2))
        h = rnd(rng.uniform(-360, 720))
        captures.append([name, mode, sectors, x, y, h, bool(geo.captures(cam, x, y, h, p))])
    raw_dirs = set()
    for f in (ROOT / "spike" / "regions").glob("*.json"):
        for rec in json.loads(f.read_text()):
            if (d := rec.get("tags", {}).get("direction")) is not None:
                raw_dirs.add(d)
    edge_cases = ["45", "-30", "360", "90;270", "10-30", "350-10", "NE", "ssw", "forward", "fixed",
                  "150000099", "", " 90 ; 180 ", "1.5", "-0", "0-0", "N;S", "90;fixed"]
    weird = sorted(d for d in raw_dirs if geo.parse_direction(d) is None or ";" in d or "-" in d)
    directions = sorted(set(edge_cases) | set(weird[:400]) | set(sorted(raw_dirs)[:200]))
    out = {"note": "sector: [px, py, bearing, half_angle, range, distance]; "
                   "captures: [profile, mode, sectors, x, y, heading, captured]",
           "sector": sector, "captures": captures,
           "directions": [[d, geo.parse_direction(d)] for d in directions],
           "profiles": {k: vars(v) for k, v in geo.PROFILES.items()}}
    (TS_FIXTURES / "reference_cases.json").write_text(json.dumps(out))
    print(f"reference cases: {len(sector)} sector, {len(captures)} captures, {len(directions)} directions")


def write_dallas() -> None:
    geo, exp = _spike("geometry"), _spike("exposure")
    pack, cams_path = DATA / "packs" / "dallas.fwr", DATA / "packs" / "dallas.cameras.json"
    meta, arr = read_pack(pack)
    q = decode_vertices(arr)
    proj = geo.LocalProjection(meta["lat0"], meta["lon0"])
    x, y = proj.to_xy(q[:, 0] / meta["coord_scale"], q[:, 1] / meta["coord_scale"])
    xy = np.column_stack([x, y])
    offsets = arr["geom_ptr"].astype(np.int64)
    seg = np.hypot(*np.diff(xy, axis=0).T)
    seg[offsets[1:-1] - 1] = 0.0
    geom_len = np.add.reduceat(np.append(seg, 0.0), offsets[:-1])

    records = json.loads(cams_path.read_text())["cameras"]
    params = geo.PROFILES["default"]
    cx, cy = proj.to_xy([r["lon"] for r in records], [r["lat"] for r in records])
    cams = [geo.camera_from_tags(r["id"], float(a), float(b), r.get("tags", {}), params)
            for r, a, b in zip(records, cx, cy, strict=True)]
    site_of = exp.cluster_sites(cams)
    site_key = {}
    for i, s in enumerate(site_of.tolist()):
        site_key[s] = min(site_key.get(s, records[i]["id"]), records[i]["id"])
    samples = exp.sample_geometries(offsets, xy, 5.0)
    ex = exp.edge_exposure(samples, cams, params, arr["edge_geom"].astype(np.int64),
                           (arr["edge_flags"] & 1).astype(bool), geom_len, site_of=site_of)
    rows = []
    for e in np.flatnonzero(np.diff(ex.site_ptr)):
        for k in range(ex.site_ptr[e], ex.site_ptr[e + 1]):
            rows.append([int(e), site_key[int(ex.site_idx[k])], round(float(ex.site_entry[k]), 4),
                         round(float(ex.site_units[k]), 6)])
    out = DATA / "fixtures"
    out.mkdir(parents=True, exist_ok=True)
    (out / "dallas_exposure.json").write_text(json.dumps({
        "profile": "default", "sites": int(site_of.max()) + 1, "rows": rows,
        "note": "[edge, site key = smallest camera OSM id in the site, entry metres, units]"}))
    print(f"dallas exposure: {len(rows)} (edge, site) rows over {len(set(r[0] for r in rows))} edges")

    xp = _spike("experiment")
    from scipy.sparse.csgraph import connected_components

    net = xp.Network(SPIKE / "data" / "Dallas.graph.npz")
    any_csr, _, _ = net.csr(net.time)
    _, labels = connected_components(any_csr, directed=True, connection="strong")
    big = np.flatnonzero(labels == np.bincount(labels).argmax())
    rng = np.random.default_rng(xp.SEED)
    trips = []
    for src in rng.choice(big, xp.N_SOURCES, replace=False):
        d = np.hypot(*(net.node_xy[big] - net.node_xy[src]).T) / 1000
        cand = big[(d >= xp.TRIP_KM[0]) & (d <= xp.TRIP_KM[1])]
        for t in rng.choice(cand, xp.TARGETS_PER_SOURCE, replace=False):
            trips.append([*net.node_lonlat[src].tolist(), *net.node_lonlat[t].tolist()])
    (out / "dallas_trips.json").write_text(json.dumps({"note": "[lon0, lat0, lon1, lat1]", "trips": trips}))
    print(f"dallas trips: {len(trips)}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dallas", action="store_true", help="also write the Dallas fixtures (needs data/)")
    args = ap.parse_args()
    write_grid()
    write_reference_cases()
    if args.dallas:
        write_dallas()


if __name__ == "__main__":
    main()
