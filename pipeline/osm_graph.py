"""OSM extract -> drivable road graph for routing packs.

Ways are split at intersections into *geometries* (intersection-to-intersection polylines);
each allowed travel direction of a geometry is a directed *edge*. Also extracted: turn
restrictions (via-node relations) and traffic signals. The graph is cut to its largest
strongly connected component, so any snapped point can reach any other.

Coordinates are quantised to integer micro-degrees (~0.1 m) before anything is measured,
so lengths and headings agree with what a device decodes from the pack.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np
import osmium
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components

EARTH_RADIUS_M = 6_371_008.8
COORD_SCALE = 1_000_000  # micro-degrees
SIGNAL_DELAY_S = 8.0  # mean wait per traffic signal passed
HEADING_LOOKAHEAD_M = 20.0  # turn angles use the first/last 20 m, not a stub segment

# Free-flow car speeds (km/h) for ways without a usable maxspeed.
DEFAULT_KMH = {
    "motorway": 105, "motorway_link": 60, "trunk": 90, "trunk_link": 50,
    "primary": 65, "primary_link": 45, "secondary": 55, "secondary_link": 40,
    "tertiary": 45, "tertiary_link": 35, "unclassified": 40, "residential": 30,
    "living_street": 15, "service": 20,
}
HIGHWAY_CLASSES = list(DEFAULT_KMH)
# Parking aisles and driveways would let routes cut through retail lots, which is both
# unrealistic and exactly where retail-operated ALPRs sit.
SKIP_SERVICE = {"parking_aisle", "driveway", "drive-through", "emergency_access"}
NO_ACCESS = {"no", "private", "agricultural", "forestry"}
_MAXSPEED = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(mph)?\s*$")
_TURN_OF_KIND = {"left_turn": "left", "right_turn": "right", "straight_on": "straight",
                 "u_turn": "u"}


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


def turn_class(h_in: float, h_out: float) -> str:
    """Classify a turn by the change in compass heading (right-hand positive)."""
    d = (h_out - h_in + 180.0) % 360.0 - 180.0
    if abs(d) < 40:
        return "straight"
    if abs(d) > 160:
        return "u"
    return "right" if d > 0 else "left"


class _Collector(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        self.way_refs: list[np.ndarray] = []
        self.way_coords: list[np.ndarray] = []  # (k, 2) int64 micro-degrees (lon, lat)
        self.way_attrs: list[tuple[int, float, bool, bool, int]] = []  # class, km/h, fwd, rev, id
        self.signals: set[int] = set()
        self.restrictions: list[tuple[str, int, int, int]] = []  # kind, from way, via node, to way
        self.unsupported_restrictions = 0  # via-way, multi-member or unknown kinds
        self.incomplete_ways = 0

    def node(self, n) -> None:
        if n.tags.get("highway") == "traffic_signals":
            self.signals.add(n.id)

    def way(self, w) -> None:
        tags = {t.k: t.v for t in w.tags}
        hw = drivable_highway(tags)
        if hw is None or len(w.nodes) < 2:
            return
        if not all(n.location.valid() for n in w.nodes):
            self.incomplete_ways += 1  # crosses the extract boundary
            return
        fwd, rev = travel_directions(tags, hw)
        kmh = parse_maxspeed(tags.get("maxspeed")) or DEFAULT_KMH[hw]
        self.way_refs.append(np.fromiter((n.ref for n in w.nodes), np.int64, len(w.nodes)))
        # osmium stores 1e-7 degrees; packs carry micro-degrees.
        self.way_coords.append(np.array(
            [(round(n.location.x / 10), round(n.location.y / 10)) for n in w.nodes], np.int64))
        self.way_attrs.append((HIGHWAY_CLASSES.index(hw), kmh, fwd, rev, w.id))

    def relation(self, r) -> None:
        tags = {t.k: t.v for t in r.tags}
        if tags.get("type") != "restriction":
            return
        kind = tags.get("restriction:motorcar") or tags.get("restriction") or ""
        if "motorcar" in tags.get("except", "").split(";"):
            return
        frm, via, to, via_way = [], [], [], False
        for m in r.members:
            if m.role == "from" and m.type == "w":
                frm.append(m.ref)
            elif m.role == "to" and m.type == "w":
                to.append(m.ref)
            elif m.role == "via" and m.type == "n":
                via.append(m.ref)
            elif m.role == "via":
                via_way = True
        if (len(frm), len(via), len(to)) == (1, 1, 1) and not via_way and kind.startswith(("no_", "only_")):
            self.restrictions.append((kind, frm[0], via[0], to[0]))
        else:
            self.unsupported_restrictions += 1


@dataclass
class RoadGraph:
    lat0: float  # projection origin used for every metric quantity below
    lon0: float
    geom_ptr: np.ndarray  # (g + 1,) offsets into the vertex arrays
    geom_q: np.ndarray  # (v, 2) int64 micro-degrees (lon, lat)
    geom_way: np.ndarray  # (g,) OSM way id
    edge_src: np.ndarray  # (m,) ascending; edges are numbered in this order
    edge_dst: np.ndarray
    edge_geom: np.ndarray
    edge_rev: np.ndarray  # bool: travels the geometry end -> start
    edge_len: np.ndarray  # metres
    edge_time: np.ndarray  # seconds: free-flow plus signal delay
    edge_class: np.ndarray  # index into HIGHWAY_CLASSES
    edge_h0: np.ndarray  # compass degrees leaving the start node
    edge_h1: np.ndarray  # compass degrees arriving at the end node
    ban_from: np.ndarray  # forbidden edge -> edge transitions, sorted
    ban_to: np.ndarray
    n_nodes: int
    stats: dict = field(default_factory=dict)

    @property
    def out_ptr(self) -> np.ndarray:
        return np.searchsorted(self.edge_src, np.arange(self.n_nodes + 1)).astype(np.uint32)


def _point_along(xs: list[float], ys: list[float], i: int, j: int, dist: float) -> tuple[float, float]:
    """Point `dist` metres along the polyline from vertex i towards vertex j (either order)."""
    step = 1 if j > i else -1
    k, left = i, dist
    while k != j:
        dx, dy = xs[k + step] - xs[k], ys[k + step] - ys[k]
        seg = math.hypot(dx, dy)
        if seg > 0 and seg >= left:
            t = left / seg
            return xs[k] + t * dx, ys[k] + t * dy
        left -= seg
        k += step
    return xs[j], ys[j]


def _bearing(x0: float, y0: float, x1: float, y1: float) -> float:
    return math.degrees(math.atan2(x1 - x0, y1 - y0)) % 360.0


def build_graph(path: str) -> RoadGraph:
    h = _Collector()
    h.apply_file(str(path), locations=True)
    refs = np.concatenate(h.way_refs)
    coords = np.concatenate(h.way_coords)
    way_off = np.concatenate([[0], np.cumsum([len(r) for r in h.way_refs])])
    way_of_vertex = np.repeat(np.arange(len(h.way_refs)), np.diff(way_off))

    # Split at nodes used more than once, and at way ends. Consecutive cut points within
    # one way bound a geometry.
    uniq, counts = np.unique(refs, return_counts=True)
    split = counts[np.searchsorted(uniq, refs)] > 1
    split[way_off[:-1]] = True
    split[way_off[1:] - 1] = True
    cuts = np.flatnonzero(split)
    same_way = way_of_vertex[cuts[:-1]] == way_of_vertex[cuts[1:]]
    gi, gj = cuts[:-1][same_way], cuts[1:][same_way]
    n_v = gj - gi + 1
    ptr = np.concatenate([[0], np.cumsum(n_v)])
    vidx = np.repeat(gi - ptr[:-1], n_v) + np.arange(ptr[-1])
    q = coords[vidx]
    signal_ids = np.fromiter(h.signals, np.int64, len(h.signals))
    is_signal = np.isin(refs[vidx], signal_ids)

    gw = way_of_vertex[gi]
    attrs = list(zip(*h.way_attrs, strict=True))
    g_class = np.array(attrs[0], np.uint8)[gw]
    g_kmh = np.array(attrs[1], np.float64)[gw]
    g_fwd, g_rev = np.array(attrs[2], bool)[gw], np.array(attrs[3], bool)[gw]
    g_way = np.array(attrs[4], np.int64)[gw]
    node_refs = np.unique(refs[cuts])
    gu, gv = np.searchsorted(node_refs, refs[gi]), np.searchsorted(node_refs, refs[gj])

    lon, lat = q[:, 0] / COORD_SCALE, q[:, 1] / COORD_SCALE
    lat0, lon0 = (lat.min() + lat.max()) / 2, (lon.min() + lon.max()) / 2
    ky = math.radians(1.0) * EARTH_RADIUS_M
    kx = ky * math.cos(math.radians(lat0))
    x, y = (lon - lon0) * kx, (lat - lat0) * ky
    seg = np.hypot(np.diff(x), np.diff(y))
    seg[ptr[1:-1] - 1] = 0.0  # joins between consecutive geometries
    g_len = np.add.reduceat(np.append(seg, 0.0), ptr[:-1])

    xs, ys = x.tolist(), y.tolist()
    g_h0, g_h1 = np.empty(len(gi)), np.empty(len(gi))
    for g in range(len(gi)):
        a, b = int(ptr[g]), int(ptr[g + 1]) - 1
        g_h0[g] = _bearing(xs[a], ys[a], *_point_along(xs, ys, a, b, HEADING_LOOKAHEAD_M))
        g_h1[g] = _bearing(*_point_along(xs, ys, b, a, HEADING_LOOKAHEAD_M), xs[b], ys[b])

    # A signal delays the edges that pass through it or arrive at it, not ones leaving it.
    csig = np.concatenate([[0], np.cumsum(is_signal)])
    sig_fwd = csig[ptr[1:]] - csig[ptr[:-1] + 1]
    sig_rev = csig[ptr[1:] - 1] - csig[ptr[:-1]]

    fwd_g, rev_g = np.flatnonzero(g_fwd), np.flatnonzero(g_rev)
    e_geom = np.concatenate([fwd_g, rev_g])
    e_rev = np.r_[np.zeros(len(fwd_g), bool), np.ones(len(rev_g), bool)]
    e_src = np.where(e_rev, gv[e_geom], gu[e_geom])
    e_dst = np.where(e_rev, gu[e_geom], gv[e_geom])

    adj = csr_matrix((np.ones(len(e_src)), (e_src, e_dst)), shape=(len(node_refs),) * 2)
    _, labels = connected_components(adj, directed=True, connection="strong")
    keep_node = labels == np.bincount(labels).argmax()
    keep_e = keep_node[e_src] & keep_node[e_dst]
    keep_g = np.zeros(len(gi), bool)
    keep_g[e_geom[keep_e]] = True

    node_new = np.cumsum(keep_node) - 1
    geom_new = np.cumsum(keep_g) - 1
    e_geom, e_rev = e_geom[keep_e], e_rev[keep_e]
    e_src, e_dst = node_new[e_src[keep_e]], node_new[e_dst[keep_e]]
    e_len = g_len[e_geom]
    signals = np.where(e_rev, sig_rev[e_geom], sig_fwd[e_geom])
    e_time = e_len / (g_kmh[e_geom] / 3.6) + SIGNAL_DELAY_S * signals
    e_h0 = np.where(e_rev, (g_h1[e_geom] + 180.0) % 360.0, g_h0[e_geom])
    e_h1 = np.where(e_rev, (g_h0[e_geom] + 180.0) % 360.0, g_h1[e_geom])
    e_class = g_class[e_geom]
    e_way = g_way[e_geom]
    e_geom = geom_new[e_geom]
    order = np.lexsort((e_rev, e_geom, e_src))
    e_src, e_dst, e_geom, e_rev, e_len, e_time, e_h0, e_h1, e_class, e_way = (
        a[order] for a in (e_src, e_dst, e_geom, e_rev, e_len, e_time, e_h0, e_h1, e_class, e_way))

    n_nodes = int(keep_node.sum())
    out_ptr = np.searchsorted(e_src, np.arange(n_nodes + 1))
    ref_to_node = dict(zip(node_refs[keep_node].tolist(), range(n_nodes), strict=True))
    ban_from, ban_to, n_resolved = _resolve_restrictions(
        h.restrictions, ref_to_node, e_src, e_dst, e_way, e_h0, e_h1, out_ptr)

    vkeep = np.repeat(keep_g, n_v)
    stats = {
        "drivable_ways": len(h.way_refs), "incomplete_ways": h.incomplete_ways,
        "geometries_dropped_outside_scc": int((~keep_g).sum()),
        "edges_dropped_outside_scc": int((~keep_e).sum()),
        "traffic_signals": len(h.signals),
        "restrictions_found": len(h.restrictions), "restrictions_applied": n_resolved,
        "restrictions_unsupported": h.unsupported_restrictions,
        "banned_transitions": len(ban_from),
    }
    return RoadGraph(
        lat0=float(lat0), lon0=float(lon0),
        geom_ptr=np.concatenate([[0], np.cumsum(n_v[keep_g])]), geom_q=q[vkeep],
        geom_way=g_way[keep_g], edge_src=e_src, edge_dst=e_dst, edge_geom=e_geom, edge_rev=e_rev,
        edge_len=e_len, edge_time=e_time, edge_class=e_class, edge_h0=e_h0, edge_h1=e_h1,
        ban_from=ban_from, ban_to=ban_to, n_nodes=n_nodes, stats=stats,
    )


def _resolve_restrictions(restrictions, ref_to_node, e_src, e_dst, e_way, e_h0, e_h1, out_ptr):
    """Turn via-node restrictions into banned (edge, edge) transitions.

    Well-formed relations have from/to ways that end at the via node, giving one edge pair.
    When a way runs through the via node instead, the pairs are narrowed to the turn the
    restriction names (left, right, straight, U), so `no_right_turn` never bans a left.
    """
    incoming, outgoing = defaultdict(list), defaultdict(list)
    for e, (s, d, w) in enumerate(zip(e_src.tolist(), e_dst.tolist(), e_way.tolist(), strict=True)):
        incoming[(d, w)].append(e)
        outgoing[(s, w)].append(e)
    bans: set[tuple[int, int]] = set()
    applied = 0
    for kind, frm, via, to in restrictions:
        v = ref_to_node.get(via)
        if v is None:
            continue
        pairs = [(a, b) for a in incoming.get((v, frm), []) for b in outgoing.get((v, to), [])]
        turn = _TURN_OF_KIND.get(kind.split("_", 1)[1])
        if len(pairs) > 1 and turn:
            pairs = [(a, b) for a, b in pairs if turn_class(e_h1[a], e_h0[b]) == turn]
        if not pairs:
            continue
        applied += 1
        if kind.startswith("no_"):
            bans.update(pairs)
        else:  # only_*: every other exit from the via node is banned for that approach
            for a in {a for a, _ in pairs}:
                allowed = {b for a2, b in pairs if a2 == a}
                bans.update((a, b) for b in range(out_ptr[v], out_ptr[v + 1]) if b not in allowed)
    ban = np.array(sorted(bans), np.int64).reshape(-1, 2)
    return ban[:, 0], ban[:, 1], applied
